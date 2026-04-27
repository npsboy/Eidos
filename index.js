import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import https from "https";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
console.log("PORT FROM ENV:", process.env.PORT);

process.on("exit", (code) => {
  console.log("🚨 PROCESS EXIT EVENT:", code);
});

process.on("uncaughtException", (err) => {
  console.error("🚨 UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("🚨 UNHANDLED REJECTION:", err);
});

const DEFAULT_MAX_POSTS = Number.parseInt(process.env.DEFAULT_MAX_POSTS || "2", 10);
const DEFAULT_ACCOUNTS = (process.env.DEFAULT_ACCOUNTS || "plaeto.schools")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const APIFY_INSTAGRAM_ACTOR = process.env.APIFY_INSTAGRAM_ACTOR || "apify/instagram-post-scraper";
const OUTPUT_DIR = path.resolve(__dirname, "outputs");

const classifierPromptPath = path.resolve(__dirname, "classifier_prompt.md");
const interpreterPromptPath = path.resolve(__dirname, "interpreter_prompt.md");

const categories = {
  intent: [
    "Promotional",
    "Educational",
    "Engagement",
    "Branding",
    "Social_Proof",
    "Announcement",
    "Entertainment",
  ],
  format: [
    "Trend",
    "Meme",
    "Tutorial",
    "Behind_the_Scenes",
    "User_Generated_Content",
    "Influencer_Collaboration",
    "Aesthetic",
    "event",
  ],
};

let latestRun = null;
let isAnalysisRunning = false;

function readPromptSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function getPrompts() {
  return {
    classifierPrompt: readPromptSafe(classifierPromptPath),
    interpreterPrompt: readPromptSafe(interpreterPromptPath),
  };
}

function cleanJsonResponse(text) {
  return String(text)
    .replace(/^```json/im, "")
    .replace(/^```/im, "")
    .replace(/```$/m, "")
    .trim();
}

function parseModelJson(text) {
  const cleaned = cleanJsonResponse(text);
  return JSON.parse(cleaned);
}

function shouldStreamAnalysis(req) {
  if (req.body?.stream === true) {
    return true;
  }

  const acceptsSse = String(req.headers.accept || "").toLowerCase().includes("text/event-stream");
  return acceptsSse;
}

function initializeSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function fetchJson(url, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode || 500;

          if (statusCode >= 400) {
            reject(new Error(`Request failed (${statusCode}): ${responseBody || "No response body"}`));
            return;
          }

          if (!responseBody) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`Unable to parse JSON response: ${error.message}`));
          }
        });
      },
    );

    req.on("error", (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function fetchOpenRouter(prompt, imageUrl) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      reject(new Error("OPENROUTER_API_KEY is missing"));
      return;
    }

    let contentPayload = [{ type: "text", text: prompt }];
    if (imageUrl) {
      contentPayload = [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ];
    }

    const data = JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "google/gemma-4-26b-a4b-it",
      messages: [{ role: "user", content: contentPayload }],
    });

    const req = https.request(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error?.message || `OpenRouter error (${res.statusCode})`));
              return;
            }
            resolve(parsed.choices?.[0]?.message?.content || "");
          } catch (error) {
            reject(new Error(`Unable to parse OpenRouter response: ${error.message}`));
          }
        });
      },
    );

    req.on("error", (error) => {
      reject(new Error(`OpenRouter request failed: ${error.message}`));
    });

    req.write(data);
    req.end();
  });
}

async function getAccountPosts(account, maxPosts) {
  if (!APIFY_TOKEN) {
    throw new Error("APIFY_TOKEN is missing");
  }

  const requestedLimit = Number.isInteger(maxPosts) && maxPosts > 0
    ? maxPosts
    : DEFAULT_MAX_POSTS;

  const input = {
    dataDetailLevel: "basicData",
    resultsLimit: requestedLimit,
    skipPinnedPosts: false,
    username: [account],
  };

  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_INSTAGRAM_ACTOR)}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true&format=json`;
  const response = await fetchJson(url, { method: "POST", body: input });
  const posts = Array.isArray(response)
    ? response
    : (Array.isArray(response?.items) ? response.items : []);

  // If the account has fewer posts than requested, return all available posts.
  const availablePosts = posts.slice(0, requestedLimit);

  return availablePosts.map((item) => {
    const sourceUrl = item?.url || item?.inputUrl || (item?.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : "");
    const normalizedType = String(item?.type || "").toLowerCase();
    const productType = String(item?.productType || "").toLowerCase();

    return {
      link: sourceUrl,
      img: item?.displayUrl || (Array.isArray(item?.images) ? item.images[0] : null) || null,
      type: normalizedType === "video" || productType === "clips" || sourceUrl.includes("/reel/")
        ? "reel"
        : "post",
      likes: item?.likesCount ?? "N/A",
      comments: item?.commentsCount ?? "N/A",
      caption: item?.caption || "No caption",
      date: item?.timestamp || "N/A",
    };
  });
}

async function extractPostData(post, classifierPrompt, customCategories = null) {
  const enrichedPost = {
    ...post,
    likes: post.likes ?? "N/A",
    comments: post.comments ?? "N/A",
    caption: post.caption || "No caption",
    date: post.date || "N/A",
  };

  try {
    const appliedCategories = customCategories || categories;
    const promptText = `${classifierPrompt}\n\nHere is the post caption: "${enrichedPost.caption}", and these are the categories: ${JSON.stringify(appliedCategories)}.`;
    const classificationText = await fetchOpenRouter(promptText, enrichedPost.img);

    let parsedResponse = {};
    try {
      parsedResponse = parseModelJson(classificationText);
    } catch {
      parsedResponse = {};
    }

    enrichedPost.intent = parsedResponse.intent || "Unknown";
    enrichedPost.format = parsedResponse.format || "Unknown";
  } catch {
    enrichedPost.intent = "Unknown";
    enrichedPost.format = "Unknown";
  }

  return enrichedPost;
}

function parseLikes(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string") {
    return Number.NaN;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return Number.NaN;
  }

  if (normalized.endsWith("k")) {
    return Number.parseFloat(normalized) * 1000;
  }
  if (normalized.endsWith("m")) {
    return Number.parseFloat(normalized) * 1000000;
  }
  if (normalized.endsWith("b")) {
    return Number.parseFloat(normalized) * 1000000000;
  }

  const parsed = Number.parseFloat(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function calculateAverageTimeBetweenPosts(posts) {
  const validDates = posts
    .map((post) => post.date)
    .filter((date) => date && date !== "N/A" && !Number.isNaN(new Date(date).getTime()))
    .map((date) => new Date(date).getTime())
    .sort((a, b) => a - b);

  if (validDates.length <= 1) {
    return "N/A";
  }

  let totalDiff = 0;
  for (let index = 1; index < validDates.length; index += 1) {
    totalDiff += validDates[index] - validDates[index - 1];
  }

  const avgTimeBetweenPostsHours = (totalDiff / (validDates.length - 1)) / (1000 * 60 * 60);
  if (avgTimeBetweenPostsHours < 1) {
    return `${Math.round(avgTimeBetweenPostsHours * 60)} minutes`;
  }
  if (avgTimeBetweenPostsHours < 24) {
    return `${Math.round(avgTimeBetweenPostsHours)} hours`;
  }
  return `${Math.round(avgTimeBetweenPostsHours / 24)} days`;
}

function getAvgLikesComments(posts) {
  let totalLikes = 0;
  let totalComments = 0;
  let likesCount = 0;
  let commentsCount = 0;

  for (const post of posts) {
    const likes = parseLikes(post.likes);
    if (!Number.isNaN(likes)) {
      totalLikes += likes;
      likesCount += 1;
    }

    const comments = parseLikes(post.comments);
    if (!Number.isNaN(comments)) {
      totalComments += comments;
      commentsCount += 1;
    }
  }

  return {
    avgLikes: likesCount > 0 ? totalLikes / likesCount : "N/A",
    avgComments: commentsCount > 0 ? totalComments / commentsCount : "N/A",
  };
}

function formatRelativePerformance(value) {
  if (value === "N/A") {
    return "N/A";
  }
  if (value === Infinity) {
    return "Infinity%";
  }
  if (value === -Infinity) {
    return "-Infinity%";
  }
  return `${value.toFixed(2)}%`;
}

function calculateRelativePerformance(categoryAverage, baselineAverage) {
  if (baselineAverage === "N/A" || categoryAverage === "N/A") {
    return "N/A";
  }

  if (baselineAverage === 0) {
    if (categoryAverage === 0) {
      return 0;
    }
    return categoryAverage > 0 ? Infinity : -Infinity;
  }

  return ((categoryAverage - baselineAverage) / baselineAverage) * 100;
}

function getCategoryDistribution(posts) {
  const intentCounts = {};
  const formatCounts = {};

  const averages = getAvgLikesComments(posts);
  const avgLikes = averages.avgLikes;
  const avgComments = averages.avgComments;

  for (const post of posts) {
    const intents = Array.isArray(post.intent) ? post.intent : [post.intent || "Unknown"];
    const formats = Array.isArray(post.format) ? post.format : [post.format || "Unknown"];

    for (const intent of intents) {
      if (!intentCounts[intent]) {
        intentCounts[intent] = {
          no_of_posts: 0,
          category_total_likes: 0,
          category_total_comments: 0,
        };
      }
      intentCounts[intent].no_of_posts += 1;

      const likes = parseLikes(post.likes);
      const comments = parseLikes(post.comments);
      if (!Number.isNaN(likes)) {
        intentCounts[intent].category_total_likes += likes;
      }
      if (!Number.isNaN(comments)) {
        intentCounts[intent].category_total_comments += comments;
      }
    }

    for (const format of formats) {
      if (!formatCounts[format]) {
        formatCounts[format] = {
          no_of_posts: 0,
          category_total_likes: 0,
          category_total_comments: 0,
        };
      }
      formatCounts[format].no_of_posts += 1;

      const likes = parseLikes(post.likes);
      const comments = parseLikes(post.comments);
      if (!Number.isNaN(likes)) {
        formatCounts[format].category_total_likes += likes;
      }
      if (!Number.isNaN(comments)) {
        formatCounts[format].category_total_comments += comments;
      }
    }
  }

  for (const intent of Object.keys(intentCounts)) {
    const categoryAvgLikes = avgLikes !== "N/A"
      ? intentCounts[intent].category_total_likes / intentCounts[intent].no_of_posts
      : "N/A";
    const categoryAvgComments = avgComments !== "N/A"
      ? intentCounts[intent].category_total_comments / intentCounts[intent].no_of_posts
      : "N/A";

    intentCounts[intent].category_avg_likes = categoryAvgLikes;
    intentCounts[intent].category_avg_comments = categoryAvgComments;
    intentCounts[intent].relative_performance = {
      likes: formatRelativePerformance(calculateRelativePerformance(categoryAvgLikes, avgLikes)),
      comments: formatRelativePerformance(calculateRelativePerformance(categoryAvgComments, avgComments)),
    };
  }

  for (const format of Object.keys(formatCounts)) {
    const categoryAvgLikes = avgLikes !== "N/A"
      ? formatCounts[format].category_total_likes / formatCounts[format].no_of_posts
      : "N/A";
    const categoryAvgComments = avgComments !== "N/A"
      ? formatCounts[format].category_total_comments / formatCounts[format].no_of_posts
      : "N/A";

    formatCounts[format].category_avg_likes = categoryAvgLikes;
    formatCounts[format].category_avg_comments = categoryAvgComments;
    formatCounts[format].relative_performance = {
      likes: formatRelativePerformance(calculateRelativePerformance(categoryAvgLikes, avgLikes)),
      comments: formatRelativePerformance(calculateRelativePerformance(categoryAvgComments, avgComments)),
    };
  }

  return {
    intentDistribution: intentCounts,
    formatDistribution: formatCounts,
  };
}

function getAnalysisInsights(analysis) {
  const globalIntentPerformance = {};
  const globalFormatPerformance = {};

  function parsePercent(value) {
    if (!value || value === "N/A") {
      return null;
    }
    if (value === "Infinity%") {
      return Infinity;
    }
    if (value === "-Infinity%") {
      return -Infinity;
    }
    return Number.parseFloat(value.replace("%", ""));
  }

  function calculateMedian(values) {
    const filtered = values.filter((value) => value !== Infinity && value !== -Infinity);
    if (filtered.length === 0) {
      return null;
    }

    const sorted = [...filtered].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 !== 0) {
      return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  const totalAccounts = Object.keys(analysis).length;

  for (const account of Object.keys(analysis)) {
    const accountData = analysis[account];
    const intentDist = accountData.intentDistribution || {};
    const formatDist = accountData.formatDistribution || {};

    for (const intent of Object.keys(intentDist)) {
      if (!globalIntentPerformance[intent]) {
        globalIntentPerformance[intent] = { likes: [], comments: [], wins: { likes: 0, comments: 0 } };
      }

      const perf = intentDist[intent].relative_performance;
      const likes = parsePercent(perf?.likes);
      const comments = parsePercent(perf?.comments);

      if (likes !== null && !Number.isNaN(likes)) {
        globalIntentPerformance[intent].likes.push(likes);
        if (likes > 0) {
          globalIntentPerformance[intent].wins.likes += 1;
        }
      }

      if (comments !== null && !Number.isNaN(comments)) {
        globalIntentPerformance[intent].comments.push(comments);
        if (comments > 0) {
          globalIntentPerformance[intent].wins.comments += 1;
        }
      }
    }

    for (const format of Object.keys(formatDist)) {
      if (!globalFormatPerformance[format]) {
        globalFormatPerformance[format] = { likes: [], comments: [], wins: { likes: 0, comments: 0 } };
      }

      const perf = formatDist[format].relative_performance;
      const likes = parsePercent(perf?.likes);
      const comments = parsePercent(perf?.comments);

      if (likes !== null && !Number.isNaN(likes)) {
        globalFormatPerformance[format].likes.push(likes);
        if (likes > 0) {
          globalFormatPerformance[format].wins.likes += 1;
        }
      }

      if (comments !== null && !Number.isNaN(comments)) {
        globalFormatPerformance[format].comments.push(comments);
        if (comments > 0) {
          globalFormatPerformance[format].wins.comments += 1;
        }
      }
    }
  }

  function aggregate(performanceDict) {
    const result = {};

    for (const key of Object.keys(performanceDict)) {
      const likesValues = performanceDict[key].likes.filter((value) => value !== Infinity && value !== -Infinity);
      const commentsValues = performanceDict[key].comments.filter((value) => value !== Infinity && value !== -Infinity);

      const avgLikes = likesValues.length > 0
        ? likesValues.reduce((sum, value) => sum + value, 0) / likesValues.length
        : null;
      const avgComments = commentsValues.length > 0
        ? commentsValues.reduce((sum, value) => sum + value, 0) / commentsValues.length
        : null;

      const medianLikes = calculateMedian(performanceDict[key].likes);
      const medianComments = calculateMedian(performanceDict[key].comments);

      const winRateLikes = totalAccounts > 0
        ? (performanceDict[key].wins.likes / totalAccounts) * 100
        : 0;
      const winRateComments = totalAccounts > 0
        ? (performanceDict[key].wins.comments / totalAccounts) * 100
        : 0;

      result[key] = {
        global_relative_performance_average: {
          likes: avgLikes !== null ? `${avgLikes.toFixed(2)}%` : "N/A",
          comments: avgComments !== null ? `${avgComments.toFixed(2)}%` : "N/A",
        },
        global_relative_performance_median: {
          likes: medianLikes !== null ? `${medianLikes.toFixed(2)}%` : "N/A",
          comments: medianComments !== null ? `${medianComments.toFixed(2)}%` : "N/A",
        },
        account_relative_win_rate: {
          likes: `${winRateLikes.toFixed(2)}%`,
          comments: `${winRateComments.toFixed(2)}%`,
        },
      };
    }

    return result;
  }

  return {
    intent_insights: aggregate(globalIntentPerformance),
    format_insights: aggregate(globalFormatPerformance),
  };
}

function getAdditionalInsights(analysis, rawData) {
  function formatTwoHourInterval(startHour) {
    const endHour = (startHour + 2) % 24;
    const formatHour = (hour) => `${hour.toString().padStart(2, "0")}:00`;
    return `${formatHour(startHour)} to ${formatHour(endHour)}`;
  }

  function getTimeOfDayEngagement(rawInput) {
    const bucketStats = {};

    for (const account of Object.keys(rawInput)) {
      for (const post of rawInput[account]) {
        if (!post.date || post.date === "N/A") {
          continue;
        }

        const postDate = new Date(post.date);
        if (Number.isNaN(postDate.getTime())) {
          continue;
        }

        const bucketStart = Math.floor(postDate.getHours() / 2) * 2;
        const bucketKey = formatTwoHourInterval(bucketStart);

        if (!bucketStats[bucketKey]) {
          bucketStats[bucketKey] = {
            totalLikes: 0,
            totalComments: 0,
            likesCount: 0,
            commentsCount: 0,
          };
        }

        const likes = parseLikes(post.likes);
        if (!Number.isNaN(likes)) {
          bucketStats[bucketKey].totalLikes += likes;
          bucketStats[bucketKey].likesCount += 1;
        }

        const comments = parseLikes(post.comments);
        if (!Number.isNaN(comments)) {
          bucketStats[bucketKey].totalComments += comments;
          bucketStats[bucketKey].commentsCount += 1;
        }
      }
    }

    const output = {};
    for (let startHour = 0; startHour < 24; startHour += 2) {
      const bucketKey = formatTwoHourInterval(startHour);
      const stats = bucketStats[bucketKey];
      if (!stats) {
        continue;
      }

      output[bucketKey] = {
        avgLikes: stats.likesCount > 0 ? Number((stats.totalLikes / stats.likesCount).toFixed(2)) : "N/A",
        avgComments: stats.commentsCount > 0 ? Number((stats.totalComments / stats.commentsCount).toFixed(2)) : "N/A",
      };
    }

    return output;
  }

  const analysisArray = Object.entries(analysis)
    .map(([account, data]) => ({ account, ...data }))
    .sort((a, b) => {
      const left = typeof a.averageLikesComments.avgLikes === "number" ? a.averageLikesComments.avgLikes : -1;
      const right = typeof b.averageLikesComments.avgLikes === "number" ? b.averageLikesComments.avgLikes : -1;
      return right - left;
    });

  const topPerformer = analysisArray[0] || null;

  let totalReelLikes = 0;
  let reelCount = 0;
  let totalPostLikes = 0;
  let postCount = 0;

  for (const account of Object.keys(rawData)) {
    for (const post of rawData[account]) {
      const likes = parseLikes(post.likes);
      if (Number.isNaN(likes)) {
        continue;
      }

      if (post.type === "reel") {
        totalReelLikes += likes;
        reelCount += 1;
      } else if (post.type === "post") {
        totalPostLikes += likes;
        postCount += 1;
      }
    }
  }

  const avgReelLikes = reelCount > 0 ? totalReelLikes / reelCount : 0;
  const avgPostLikes = postCount > 0 ? totalPostLikes / postCount : 0;

  let reelsPerformanceOverPosts = "N/A";
  if (avgPostLikes > 0) {
    reelsPerformanceOverPosts = `${(((avgReelLikes - avgPostLikes) / avgPostLikes) * 100).toFixed(2)}%`;
  } else if (avgReelLikes > 0) {
    reelsPerformanceOverPosts = "Infinity%";
  } else {
    reelsPerformanceOverPosts = "0.00%";
  }

  return {
    topPerformer: {
      account: topPerformer ? topPerformer.account : "Unknown",
      frequency: topPerformer ? topPerformer.averageTimeBetweenPostsReadable : "N/A",
    },
    reelsPerformanceOverPosts,
    timeOfDayEngagement: getTimeOfDayEngagement(rawData),
  };
}

function analyseData(rawData) {
  const analysis = {};

  for (const account of Object.keys(rawData)) {
    const posts = rawData[account];
    const distributions = getCategoryDistribution(posts);

    analysis[account] = {
      averageLikesComments: getAvgLikesComments(posts),
      totalPosts: posts.length,
      intentDistribution: distributions.intentDistribution,
      formatDistribution: distributions.formatDistribution,
      averageTimeBetweenPostsReadable: calculateAverageTimeBetweenPosts(posts),
    };
  }

  return {
    global_insights: getAnalysisInsights(analysis),
    additional_insights: getAdditionalInsights(analysis, rawData),
    account_analysis: analysis,
  };
}

async function generateExcelFile(globalInsights, runId) {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `global_insights_${runId}.xlsx`);

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Insights");

  worksheet.columns = [
    { header: "Category_Type", key: "type", width: 20 },
    { header: "Category_Name", key: "name", width: 25 },
    { header: "Avg_Relative_Likes", key: "avgLikes", width: 25 },
    { header: "Avg_Relative_Comments", key: "avgComments", width: 25 },
    { header: "Median_Relative_Likes", key: "medLikes", width: 25 },
    { header: "Median_Relative_Comments", key: "medComments", width: 25 },
    { header: "Win_Rate_Likes", key: "winLikes", width: 20 },
    { header: "Win_Rate_Comments", key: "winComments", width: 20 },
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };

  let currentRow = 2;

  const addSectionRows = (sectionName, sectionEntries, fillColor) => {
    if (sectionEntries.length === 0) {
      return;
    }

    const startRow = currentRow;
    for (const [name, data] of sectionEntries) {
      const row = worksheet.addRow({
        type: sectionName,
        name,
        avgLikes: data.global_relative_performance_average.likes,
        avgComments: data.global_relative_performance_average.comments,
        medLikes: data.global_relative_performance_median.likes,
        medComments: data.global_relative_performance_median.comments,
        winLikes: data.account_relative_win_rate.likes,
        winComments: data.account_relative_win_rate.comments,
      });

      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: fillColor },
        };
      });

      currentRow += 1;
    }

    worksheet.mergeCells(`A${startRow}:A${currentRow - 1}`);
    worksheet.getCell(`A${startRow}`).alignment = { horizontal: "center", vertical: "middle" };
  };

  addSectionRows("Intent", Object.entries(globalInsights.intent_insights || {}), "FFD9E1F2");
  addSectionRows("Format", Object.entries(globalInsights.format_insights || {}), "FFFCE4D6");

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function runAnalysis({
  accounts,
  maxPosts,
  includeAiOverview,
  generateExcel,
  customCategories,
  onProgress,
}) {
  const prompts = getPrompts();
  const runId = `${Date.now()}`;
  const rawData = {};
  const errors = [];

  const safeProgress = typeof onProgress === "function"
    ? onProgress
    : () => {};

  for (const account of accounts) {
    try {
      safeProgress({
        stage: "extracting_posts",
        message: "Extracting posts...",
        account,
      });

      let postData = await getAccountPosts(account, maxPosts);
      if (postData.length < maxPosts) {
        console.log(
          `Requested ${maxPosts} posts for ${account}, received ${postData.length}. Proceeding with available posts.`,
        );
      }
      for (let index = 0; index < postData.length; index += 1) {
        safeProgress({
          stage: "analyzing_post",
          message: `${account} | post ${index + 1} | ${postData[index]?.link || "N/A"}`,
          account,
          postNumber: index + 1,
          link: postData[index]?.link || "N/A",
        });

        postData[index] = await extractPostData(postData[index], prompts.classifierPrompt, customCategories);
      }
      rawData[account] = postData;
    } catch (error) {
      rawData[account] = [];
      errors.push({
        account,
        message: error.message,
      });

      safeProgress({
        stage: "account_error",
        account,
        message: error.message,
      });
    }
  }

  safeProgress({
    stage: "analyzing_data",
    message: "analysing data",
  });

  const analysis = analyseData(rawData);

  let aiOverview = null;
  if (includeAiOverview) {
    try {
      const aiOverviewPrompt = `${prompts.interpreterPrompt}\n\nHere is the analysis output: ${JSON.stringify(analysis)}\n\nHere are the accounts we analyzed: ${accounts.join(", ")}`;
      aiOverview = await fetchOpenRouter(aiOverviewPrompt);
    } catch (error) {
      aiOverview = `Overview generation failed: ${error.message}`;
    }
  }

  let excelPath = null;
  if (generateExcel) {
    excelPath = await generateExcelFile(analysis.global_insights, runId);
  }

  return {
    runId,
    createdAt: new Date().toISOString(),
    accounts,
    maxPosts,
    rawData,
    analysis,
    aiOverview,
    excelPath,
    errors,
  };
}

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "Eidos Backend API",
    status: "ok",
    routes: [
      "GET /health",
      "GET /api/categories",
      "POST /api/classify",
      "POST /api/analyze",
      "GET /api/runs/latest",
      "GET /api/runs/latest/excel",
    ],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/categories", (_req, res) => {
  res.json({ categories });
});

app.post("/api/classify", async (req, res, next) => {
  try {
    const { caption, imageUrl, categories: customCategories } = req.body || {};
    if (!caption || typeof caption !== "string") {
      res.status(400).json({ error: "caption is required and must be a string" });
      return;
    }

    const appliedCategories = customCategories || categories;
    const prompts = getPrompts();
    const promptText = `${prompts.classifierPrompt}\n\nHere is the post caption: "${caption}", and these are the categories: ${JSON.stringify(appliedCategories)}.`;

    const responseText = await fetchOpenRouter(promptText, imageUrl);
    let parsed = {};
    try {
      parsed = parseModelJson(responseText);
    } catch {
      parsed = { intent: "Unknown", format: "Unknown" };
    }

    res.json({
      classification: {
        intent: parsed.intent || "Unknown",
        format: parsed.format || "Unknown",
      },
      rawResponse: responseText,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/analyze", async (req, res, next) => {
  if (isAnalysisRunning) {
    res.status(429).json({ error: "An analysis run is already in progress" });
    return;
  }

  let stream = false;

  try {
    const requestedAccounts = Array.isArray(req.body?.accounts)
      ? req.body.accounts.map((item) => String(item).trim()).filter(Boolean)
      : DEFAULT_ACCOUNTS;

    const maxPosts = Number.parseInt(String(req.body?.maxPosts ?? DEFAULT_MAX_POSTS), 10);
    const includeAiOverview = Boolean(req.body?.includeAiOverview);
    const generateExcel = Boolean(req.body?.generateExcel);
    stream = shouldStreamAnalysis(req);

    if (requestedAccounts.length === 0) {
      res.status(400).json({ error: "accounts must contain at least one Instagram handle" });
      return;
    }

    if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 100) {
      res.status(400).json({ error: "maxPosts must be an integer between 1 and 100" });
      return;
    }

    isAnalysisRunning = true;

    if (stream) {
      initializeSse(res);
    }

    const result = await runAnalysis({
      accounts: requestedAccounts,
      maxPosts,
      includeAiOverview,
      generateExcel,
      customCategories: req.body?.categories,
      onProgress: stream
        ? (event) => writeSseEvent(res, "progress", event)
        : undefined,
    });

    latestRun = result;

    if (stream) {
      writeSseEvent(res, "final", result);
      writeSseEvent(res, "done", { message: "analysis complete" });
      res.end();
      return;
    }

    res.json(result);
  } catch (error) {
    if (stream && !res.headersSent) {
      initializeSse(res);
      writeSseEvent(res, "error", { message: error.message || "Internal Server Error" });
      res.end();
      return;
    }

    if (stream && res.headersSent) {
      writeSseEvent(res, "error", { message: error.message || "Internal Server Error" });
      res.end();
      return;
    }

    next(error);
  } finally {
    isAnalysisRunning = false;
  }
});

app.get("/api/runs/latest", (_req, res) => {
  if (!latestRun) {
    res.status(404).json({ error: "No runs found yet" });
    return;
  }

  res.json(latestRun);
});

app.get("/api/runs/latest/excel", (req, res) => {
  if (!latestRun || !latestRun.excelPath) {
    res.status(404).json({ error: "No generated Excel file available" });
    return;
  }

  if (!fs.existsSync(latestRun.excelPath)) {
    res.status(404).json({ error: "Generated Excel file no longer exists on disk" });
    return;
  }

  res.download(latestRun.excelPath);
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    error: error.message || "Internal Server Error",
  });
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Eidos backend service listening on port ${PORT}`);
});