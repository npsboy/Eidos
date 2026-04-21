import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import https from "https";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { chromium } from "playwright";
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
const STORAGE_STATE_PATH = path.resolve(__dirname, process.env.STORAGE_STATE_PATH || "state.json");
const STORAGE_STATE_JSON = process.env.STORAGE_STATE_JSON || "";
const STORAGE_STATE_BASE64 = process.env.STORAGE_STATE_BASE64 || "";
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

function extractMultilineJsonEnvValue(envText, variableName) {
  const marker = `${variableName}=`;
  const markerIndex = envText.indexOf(marker);
  if (markerIndex === -1) {
    return "";
  }

  const rawValue = envText.slice(markerIndex + marker.length).trimStart();
  if (!rawValue.startsWith("{")) {
    return rawValue.split(/\r?\n/, 1)[0].trim();
  }

  let depth = 0;
  let inString = false;
  let quoteChar = "";
  let escaped = false;
  let extracted = "";

  for (const char of rawValue) {
    extracted += char;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quoteChar) {
        inString = false;
        quoteChar = "";
      }

      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return extracted.trim();
      }
    }
  }

  return "";
}

function readStorageStateJsonFromDotenvFile() {
  const dotenvPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(dotenvPath)) {
    return "";
  }

  try {
    const dotenvContent = fs.readFileSync(dotenvPath, "utf8");
    return extractMultilineJsonEnvValue(dotenvContent, "STORAGE_STATE_JSON");
  } catch {
    return "";
  }
}

function getStorageState() {
  // Prefer env-provided state for deployment environments where files are ephemeral.
  if (STORAGE_STATE_BASE64) {
    try {
      return JSON.parse(Buffer.from(STORAGE_STATE_BASE64, "base64").toString("utf8"));
    } catch (error) {
      console.warn(`Invalid STORAGE_STATE_BASE64: ${error.message}`);
    }
  }

  let storageStateJsonError = null;

  if (STORAGE_STATE_JSON) {
    try {
      return JSON.parse(STORAGE_STATE_JSON);
    } catch (error) {
      storageStateJsonError = error;
    }
  }

  // Dotenv can truncate unquoted multiline JSON values; recover full JSON from .env when needed.
  const multilineStorageStateJson = readStorageStateJsonFromDotenvFile();
  if (multilineStorageStateJson && multilineStorageStateJson !== STORAGE_STATE_JSON) {
    try {
      return JSON.parse(multilineStorageStateJson);
    } catch (error) {
      storageStateJsonError = error;
    }
  }

  if (fs.existsSync(STORAGE_STATE_PATH)) {
    return STORAGE_STATE_PATH;
  }

  if (storageStateJsonError) {
    console.warn(`Invalid STORAGE_STATE_JSON: ${storageStateJsonError.message}`);
  }

  return null;
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

async function getAccountPosts(page, account, maxPosts) {
  await page.goto(`https://www.instagram.com/${account}/`, { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: "/tmp/insta.png", fullPage: true });
  console.log(`Attempted to navigate to https://www.instagram.com/${account}/`);
  console.log("TITLE:", await page.title());
  console.log("URL:", page.url());
  const buffer = await page.screenshot({ fullPage: true });
  console.log("SCREENSHOT_BASE64:", buffer.toString("base64"));
  await page.waitForSelector("header", { timeout: 30000 });

  await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', {
    state: "visible",
    timeout: 30000,
  });

  let posts = await page.locator('a[href*="/p/"], a[href*="/reel/"]').all();
  let previousHeight = await page.evaluate("document.body.scrollHeight");

  while (posts.length < maxPosts) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) {
      break;
    }
    previousHeight = newHeight;
    posts = await page.locator('a[href*="/p/"], a[href*="/reel/"]').all();
  }

  const postData = [];
  for (let index = 0; index < Math.min(posts.length, maxPosts); index += 1) {
    const post = posts[index];
    const link = await post.getAttribute("href");

    let img = null;
    const imgLocator = post.locator("img");
    if ((await imgLocator.count()) > 0) {
      img = await imgLocator.getAttribute("src");
    }

    if (link) {
      postData.push({
        link: `https://www.instagram.com${link}`,
        img,
        type: link.includes("/reel/") ? "reel" : "post",
      });
    }
  }

  return postData;
}

async function extractPostData(context, post, classifierPrompt, customCategories = null) {
  const postPage = await context.newPage();

  try {
    await postPage.goto(post.link, { waitUntil: "domcontentloaded" });
    await postPage.waitForSelector("main", { timeout: 15000 });

    const stats = await postPage.evaluate(() => {
      let likes = "N/A";
      let comments = "N/A";
      let captionText = "";
      let date = "N/A";

      function extractCountToken(text, labelPattern) {
        if (!text) {
          return null;
        }
        const matcher = String(text).match(new RegExp(`([\\d.,]+(?:\\s*[kmbKMB])?)\\s+${labelPattern}`, "i"));
        if (!matcher) {
          return null;
        }
        return matcher[1].replace(/\s+/g, "").trim();
      }

      function normalizeDate(dateValue) {
        if (!dateValue) {
          return null;
        }
        const parsedDate = new Date(dateValue);
        if (Number.isNaN(parsedDate.getTime())) {
          return String(dateValue).trim();
        }
        return parsedDate.toISOString();
      }

      function extractFromJsonLd() {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        const nodes = [];

        for (const script of scripts) {
          const raw = script.textContent?.trim();
          if (!raw) {
            continue;
          }

          try {
            const parsed = JSON.parse(raw);
            nodes.push(parsed);
          } catch {
            // Ignore malformed JSON-LD blocks.
          }
        }

        const stack = [...nodes];
        const extracted = {
          likes: null,
          comments: null,
          caption: null,
          date: null,
        };

        while (stack.length > 0) {
          const current = stack.pop();
          if (!current) {
            continue;
          }

          if (Array.isArray(current)) {
            for (const item of current) {
              stack.push(item);
            }
            continue;
          }

          if (typeof current !== "object") {
            continue;
          }

          const candidateDate = current.uploadDate
            || current.dateCreated
            || current.datePublished
            || current.startDate;
          if (!extracted.date && candidateDate) {
            extracted.date = normalizeDate(candidateDate);
          }

          const candidateCaption = current.caption || current.headline || current.name || current.description;
          if (!extracted.caption && typeof candidateCaption === "string" && candidateCaption.trim()) {
            extracted.caption = candidateCaption.trim();
          }

          const commentCount = current.commentCount ?? current.comments;
          if (!extracted.comments && (typeof commentCount === "number" || typeof commentCount === "string")) {
            const token = String(commentCount).trim();
            if (token) {
              extracted.comments = token;
            }
          }

          const interactions = current.interactionStatistic
            ? (Array.isArray(current.interactionStatistic)
              ? current.interactionStatistic
              : [current.interactionStatistic])
            : [];

          for (const interaction of interactions) {
            if (!interaction || typeof interaction !== "object") {
              continue;
            }

            const typeRaw = interaction.interactionType;
            const typeName = String(
              typeof typeRaw === "string"
                ? typeRaw
                : (typeRaw?.["@type"] || ""),
            ).toLowerCase();

            const interactionCount = interaction.userInteractionCount ?? interaction.interactionCount;
            const countToken = interactionCount !== undefined && interactionCount !== null
              ? String(interactionCount).trim()
              : "";

            if (!countToken) {
              continue;
            }

            if (!extracted.likes && (typeName.includes("like") || typeName.includes("favorite"))) {
              extracted.likes = countToken;
            }

            if (!extracted.comments && typeName.includes("comment")) {
              extracted.comments = countToken;
            }
          }

          for (const value of Object.values(current)) {
            if (value && typeof value === "object") {
              stack.push(value);
            }
          }
        }

        return extracted;
      }

      const jsonLdValues = extractFromJsonLd();
      if (jsonLdValues.likes) {
        likes = jsonLdValues.likes;
      }
      if (jsonLdValues.comments) {
        comments = jsonLdValues.comments;
      }
      if (jsonLdValues.caption) {
        captionText = jsonLdValues.caption;
      }
      if (jsonLdValues.date) {
        date = jsonLdValues.date;
      }

      const ogDescription = document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
      if (likes === "N/A") {
        const likeFromOg = extractCountToken(ogDescription, "likes?");
        if (likeFromOg) {
          likes = likeFromOg;
        }
      }
      if (comments === "N/A") {
        const commentsFromOg = extractCountToken(ogDescription, "comments?");
        if (commentsFromOg) {
          comments = commentsFromOg;
        }
      }

      if (comments === "N/A" && likes !== "N/A" && ogDescription) {
        const mentionsComments = /comments?/i.test(ogDescription);
        if (!mentionsComments) {
          comments = "0";
        }
      }

      const timeElement = document.querySelector("time");
      if (date === "N/A" && timeElement && timeElement.getAttribute("datetime")) {
        date = timeElement.getAttribute("datetime");
      } else if (date === "N/A" && timeElement) {
        date = timeElement.innerText;
      }

      if (date === "N/A") {
        const publishedMeta = document.querySelector('meta[property="article:published_time"]')?.getAttribute("content")
          || document.querySelector('meta[property="og:updated_time"]')?.getAttribute("content")
          || "";
        const normalizedDate = normalizeDate(publishedMeta);
        if (normalizedDate) {
          date = normalizedDate;
        }
      }

      const pageHtml = document.documentElement?.innerHTML || "";

      if (likes === "N/A") {
        const likeJsonMatch = pageHtml.match(/"like_count":(\d+)/)
          || pageHtml.match(/"edge_media_preview_like":\{"count":(\d+)/);
        if (likeJsonMatch?.[1]) {
          likes = likeJsonMatch[1];
        }
      }

      if (comments === "N/A") {
        const commentJsonMatch = pageHtml.match(/"comment_count":(\d+)/)
          || pageHtml.match(/"edge_media_to_parent_comment":\{"count":(\d+)/)
          || pageHtml.match(/"edge_media_preview_comment":\{"count":(\d+)/);
        if (commentJsonMatch?.[1]) {
          comments = commentJsonMatch[1];
        }
      }

      if (date === "N/A") {
        const timestampMatch = pageHtml.match(/"taken_at_timestamp":(\d+)/);
        if (timestampMatch?.[1]) {
          const timestampMillis = Number.parseInt(timestampMatch[1], 10) * 1000;
          if (!Number.isNaN(timestampMillis)) {
            date = new Date(timestampMillis).toISOString();
          }
        }
      }

      if (!captionText) {
        const h1Tags = document.querySelectorAll("h1");
        for (const h1 of h1Tags) {
          if (
            h1.innerText
            && h1.innerText.trim().length > 0
            && h1.innerText !== "Instagram"
            && !h1.innerText.includes("Log in")
          ) {
            captionText = h1.innerText.trim();
            break;
          }
        }
      }

      if (!captionText) {
        const metaTitle = document.querySelector('meta[property="og:title"]');
        if (metaTitle) {
          captionText = metaTitle.content;
        }
      }

      const text = document.body.innerText;
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].toLowerCase();

        if (
          line.match(
            /\s+ago$|^january\s|^february\s|^march\s|^april\s|^may\s|^june\s|^july\s|^august\s|^september\s|^october\s|^november\s|^december\s/i,
          )
          || line.includes("more posts from")
          || line.includes("log in to like")
        ) {
          const foundNumbers = [];
          let j = i - 1;
          while (j >= i - 8 && j >= 0 && foundNumbers.length < 2) {
            const lineAbove = lines[j];

            if (/^[\d,.]+([kmbKMB])?$/.test(lineAbove)) {
              foundNumbers.unshift(lineAbove);
            } else if (/(?:view\s*all\s*)?([\d,KMBkmb.]+)\s+comments?/i.test(lineAbove)) {
              const matcher = lineAbove.match(/(?:view\s*all\s*)?([\d,KMBkmb.]+)\s+comments?/i);
              if (matcher) {
                foundNumbers.unshift(matcher[1]);
              }
            } else if (/([\d,KMBkmb.]+)\s+likes?/i.test(lineAbove)) {
              if (j + 1 < lines.length && !/reply/i.test(lines[j + 1])) {
                const matcher = lineAbove.match(/([\d,KMBkmb.]+)\s+likes?/i);
                if (matcher) {
                  foundNumbers.unshift(matcher[1]);
                }
              }
            }
            j -= 1;
          }

          if (foundNumbers.length === 2) {
            if (likes === "N/A") {
              likes = foundNumbers[0];
            }
            if (comments === "N/A") {
              comments = foundNumbers[1];
            }
            break;
          }

          if (foundNumbers.length === 1) {
            if (likes === "N/A") {
              likes = foundNumbers[0];
            } else if (comments === "N/A") {
              comments = foundNumbers[0];
            }
          }
        }
      }

      return { likes, comments, captionText, date };
    });

    post.likes = stats.likes;
    post.comments = stats.comments;
    post.caption = stats.captionText || "No caption";
    post.date = stats.date;

    const appliedCategories = customCategories || categories;
    const promptText = `${classifierPrompt}\n\nHere is the post caption: "${post.caption}", and these are the categories: ${JSON.stringify(appliedCategories)}.`;
    const classificationText = await fetchOpenRouter(promptText, post.img);

    let parsedResponse = {};
    try {
      parsedResponse = parseModelJson(classificationText);
    } catch {
      parsedResponse = {};
    }

    post.intent = parsedResponse.intent || "Unknown";
    post.format = parsedResponse.format || "Unknown";
  } catch {
    post.likes = "N/A";
    post.comments = "N/A";
    post.caption = post.caption || "No caption";
    post.date = "N/A";
    post.intent = "Unknown";
    post.format = "Unknown";
  } finally {
    await postPage.close();
  }

  return post;
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

async function runAnalysis({ accounts, maxPosts, includeAiOverview, generateExcel, customCategories }) {
  const prompts = getPrompts();
  const runId = `${Date.now()}`;
  const rawData = {};
  const errors = [];

  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  try {
    const contextOptions = {};
    const storageState = getStorageState();
    if (storageState) {
      contextOptions.storageState = storageState;
    }

    const context = await browser.newContext(contextOptions);
    const cookies = await context.cookies();
    console.log("cookies loaded into browser context:", cookies.length);

    const page = await context.newPage();

    for (const account of accounts) {
      try {
        let postData = await getAccountPosts(page, account, maxPosts);
        for (let index = 0; index < postData.length; index += 1) {
          postData[index] = await extractPostData(context, postData[index], prompts.classifierPrompt, customCategories);
        }
        rawData[account] = postData;
      } catch (error) {
        rawData[account] = [];
        errors.push({
          account,
          message: error.message,
        });
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

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

  try {
    const requestedAccounts = Array.isArray(req.body?.accounts)
      ? req.body.accounts.map((item) => String(item).trim()).filter(Boolean)
      : DEFAULT_ACCOUNTS;

    const maxPosts = Number.parseInt(String(req.body?.maxPosts ?? DEFAULT_MAX_POSTS), 10);
    const includeAiOverview = Boolean(req.body?.includeAiOverview);
    const generateExcel = Boolean(req.body?.generateExcel);

    if (requestedAccounts.length === 0) {
      res.status(400).json({ error: "accounts must contain at least one Instagram handle" });
      return;
    }

    if (!Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 25) {
      res.status(400).json({ error: "maxPosts must be an integer between 1 and 25" });
      return;
    }

    isAnalysisRunning = true;

    const result = await runAnalysis({
      accounts: requestedAccounts,
      maxPosts,
      includeAiOverview,
      generateExcel,
      customCategories: req.body?.categories,
    });

    latestRun = result;
    res.json(result);
  } catch (error) {
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