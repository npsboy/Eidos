import fs from "fs";
import dotenv from "dotenv";
import { chromium } from "playwright";
import https from "https";
import { get } from "http";
import ExcelJS from "exceljs";

dotenv.config();

const maxPosts = 2;
const accounts = ["plaeto.schools"];

const classifier_prompt = fs.readFileSync("classifier_prompt.md", "utf8");

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
    "event"
  ],
};

function fetchOpenRouter(prompt, imageUrl) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY || "";

    let contentPayload = prompt;
    if (imageUrl) {
      contentPayload = [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ];
    }

    const data = JSON.stringify({
        model: "google/gemma-4-26b-a4b-it",
        messages: [
            { role: "user", content: contentPayload }
        ],
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
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(
              parsed.choices?.[0]?.message?.content ||
                "No explanation generated",
            );
          } catch (e) {
            console.error("Error parsing OpenRouter response:", e);
            resolve("Explanation Parse Error");
          }
        });
      },
    );

    req.on("error", (e) => {
      console.error("Network error while fetching OpenRouter response:", e);
      resolve("Explanation Network Error");
    });
    req.write(data);
    req.end();
  });
}

async function getAccountPosts(page, account, maxPosts) {
  await page.goto("https://www.instagram.com/" + account + "/");
  await page.waitForSelector("header");

  const followers = await page
    .locator('a[href$="/followers/"] span')
    .first()
    .innerText();
  console.log("Followers:", followers);

  await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', {
    state: "visible",
    timeout: 30000,
  });

  let posts = await page.locator('a[href*="/p/"], a[href*="/reel/"]').all();
  
  let previousHeight = await page.evaluate("document.body.scrollHeight");
  while (posts.length < maxPosts) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    try {
      await page.waitForTimeout(2000);
      let newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === previousHeight) {
        break; // Reached end of page
      }
      previousHeight = newHeight;
    } catch (e) {
      console.log("Reached end of page or no more posts loading.");
      break;
    }
    posts = await page.locator('a[href*="/p/"], a[href*="/reel/"]').all();
  }

  let postData = [];

  for (let i = 0; i < Math.min(posts.length, maxPosts); i++) {
    const post = posts[i];
    const link = await post.getAttribute("href");

    let img = null;
    const imgLocator = post.locator("img");

    if ((await imgLocator.count()) > 0) {
      img = await imgLocator.getAttribute("src");
    }

    if (link) {
      const type = link.includes("/reel/") ? "reel" : "post";
      postData.push({
        link: "https://www.instagram.com" + link,
        img,
        type,
      });
    }
  }

  return postData;
}

async function extractPostData(context, post) {
  const postPage = await context.newPage();
  console.log("Extracting data from " + post.link + "...");
  await postPage.goto(post.link);

  try {
    await postPage.waitForSelector("main", { timeout: 15000 });

    const stats = await postPage.evaluate(() => {
      let likes = "N/A";
      let comments = "N/A";
      let captionText = "";
      let date = "N/A";

      const timeElement = document.querySelector("time");
      if (timeElement && timeElement.getAttribute("datetime")) {
        date = timeElement.getAttribute("datetime");
      } else if (timeElement) {
        date = timeElement.innerText;
      }

      const h1Tags = document.querySelectorAll("h1");
      for (const h1 of h1Tags) {
        if (
          h1.innerText &&
          h1.innerText.trim().length > 0 &&
          h1.innerText !== "Instagram" &&
          !h1.innerText.includes("Log in")
        ) {
          captionText = h1.innerText.trim();
          break;
        }
      }

      if (!captionText) {
        const metaTitle = document.querySelector(
          'meta[property="og:title"]',
        );
        if (metaTitle) captionText = metaTitle.content;
      }

      const text = document.body.innerText;
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (let i = lines.length - 1; i >= 0; i--) {
        let line = lines[i].toLowerCase();

        if (
          line.match(
            /\s+ago$|^january\s|^february\s|^march\s|^april\s|^may\s|^june\s|^july\s|^august\s|^september\s|^october\s|^november\s|^december\s/i,
          ) ||
          line.includes("more posts from") ||
          line.includes("log in to like")
        ) {
          let foundNumbers = [];
          let j = i - 1;
          while (j >= i - 8 && j >= 0 && foundNumbers.length < 2) {
            let lineAbove = lines[j];

            if (/^[\d,.]+([kmbKMB])?$/.test(lineAbove)) {
              foundNumbers.unshift(lineAbove);
            } else if (
              /(?:view\s*all\s*)?([\d,KMBkmb.]+)\s+comments?/i.test(
                lineAbove,
              )
            ) {
              let matcher = lineAbove.match(
                /(?:view\s*all\s*)?([\d,KMBkmb.]+)\s+comments?/i,
              );
              if (matcher) foundNumbers.unshift(matcher[1]);
            } else if (/([\d,KMBkmb.]+)\s+likes?/i.test(lineAbove)) {
              if (j + 1 < lines.length && !/reply/i.test(lines[j + 1])) {
                let matcher = lineAbove.match(/([\d,KMBkmb.]+)\s+likes?/i);
                if (matcher) foundNumbers.unshift(matcher[1]);
              }
            }
            j--;
          }
        
          if (foundNumbers.length === 2) {
            likes = foundNumbers[0];
            comments = foundNumbers[1];
            break;
          } else if (foundNumbers.length === 1 && likes === "N/A") {
            likes = foundNumbers[0];
          }
        }
      }

      return { likes, comments, captionText, date };
    });

    post.likes = stats.likes;
    post.comments = stats.comments;
    post.caption = stats.captionText || "No caption";
    post.date = stats.date;

    const promptText =
      classifier_prompt +
      `Here is the post caption: "${post.caption}", and these are the categories: ${JSON.stringify(categories)}.`;

    console.log("Fetching explanation from OpenRouter...");
    let response = await fetchOpenRouter(promptText, post.img);

    // Clean up markdown block if present
    response = response
      .replace(/^```json/im, "")
      .replace(/```$/m, "")
      .trim();

    let parsedResponse = {};
    try {
      parsedResponse = JSON.parse(response);
    } catch (parseErr) {
      console.error("Error parsing AI response:", parseErr.message);
    }

    post.intent = parsedResponse.intent || "Unknown";
    post.format = parsedResponse.format || "Unknown";
  } catch (e) {
    console.log(
      "Could not extract likes/comments for " + post.link + ":",
      e.message,
    );
    post.likes = "N/A";
    post.comments = "N/A";
    post.date = "N/A";
    post.intent = "Unknown";
    post.format = "Unknown";
  }

  await postPage.close();
  return post;
}

function calculateAverageTimeBetweenPosts(posts) {
    let validDates = posts
        .map(p => p.date)
        .filter(d => d && d !== "N/A" && !isNaN(new Date(d).getTime()))
        .map(d => new Date(d).getTime())
        .sort((a, b) => a - b);

    let avgTimeBetweenPostsHours = 0    
    if (validDates.length > 1) {
        let totalDiff = 0;
        for (let i = 1; i < validDates.length; i++) {
            totalDiff += (validDates[i] - validDates[i - 1]);
        }
        let avgTimeBetweenPostsMs = totalDiff / (validDates.length - 1);
        avgTimeBetweenPostsHours = avgTimeBetweenPostsMs / (1000 * 60 * 60);

        // convert the avfg time between posts to a more readable format
        let avgTimeBetweenPostsReadable = "N/A";
        if (avgTimeBetweenPostsHours > 0) {
            if (avgTimeBetweenPostsHours < 1) {
                avgTimeBetweenPostsReadable = Math.round(avgTimeBetweenPostsHours * 60) + " minutes";
            } else if (avgTimeBetweenPostsHours < 24) {
                avgTimeBetweenPostsReadable = Math.round(avgTimeBetweenPostsHours) + " hours";
            } else {
                avgTimeBetweenPostsReadable = Math.round(avgTimeBetweenPostsHours / 24) + " days";
            }
        }
        return avgTimeBetweenPostsReadable;
    }
}

function getAvgLikesComments(posts) {
    let totalLikes = 0;
    let totalComments = 0;
    let count = 0;

    for (const post of posts) {
        if (post.likes && post.likes !== "N/A" && !isNaN(parseLikes(post.likes))) {
            totalLikes += parseLikes(post.likes);
            count++;
        }
        if (post.comments && post.comments !== "N/A" && !isNaN(parseLikes(post.comments))) {
            totalComments += parseLikes(post.comments);
        }
    }

    const avgLikes = count > 0 ? totalLikes / count : "N/A";
    const avgComments = count > 0 ? totalComments / count : "N/A";

    return { avgLikes, avgComments };
}

function parseLikes(likesStr) {
    if (typeof likesStr === "number") return likesStr;
    if (likesStr.endsWith("k")) {
        return parseFloat(likesStr) * 1000;
    } else if (likesStr.endsWith("m")) {
        return parseFloat(likesStr) * 1000000;
    } else if (likesStr.endsWith("b")) {
        return parseFloat(likesStr) * 1000000000;
    } else {
        return parseInt(likesStr.replace(/,/g, ""));
    }
}

function getCategoryDistribution(posts) {
    let intentCounts = {};
    let formatCounts = {};
    
    /* 
    format eg:
        {
            "Branding":{
                "no_of_posts": 10, 
                "category_total_likes": 10000,
                "category_total_comments": 500,
                "category_avg_likes": 1000,
                "category_avg_comments": 50,
                "relative_performance": {"likes": "20%", "comments": "-10%"},
            }
        }
    */


    let avgLikes = 0, avgComments = 0;
    try {
        const averages = getAvgLikesComments(posts);
        avgLikes = averages.avgLikes;
        avgComments = averages.avgComments;
    } catch {
        // Fallback if getAvgLikesComments is undefined
    }

    for (const post of posts) {
        const intents = Array.isArray(post.intent) ? post.intent : [post.intent || "Unknown"];
        for (const intent of intents) {
            if (!intentCounts[intent]) intentCounts[intent] = {};
            intentCounts[intent].no_of_posts = (intentCounts[intent].no_of_posts || 0) + 1;
            intentCounts[intent].category_total_likes = (intentCounts[intent].category_total_likes || 0) + (isNaN(parseLikes(post.likes)) ? 0 : parseLikes(post.likes));
            intentCounts[intent].category_total_comments = (intentCounts[intent].category_total_comments || 0) + (isNaN(parseLikes(post.comments)) ? 0 : parseLikes(post.comments));
        }

        const formats = Array.isArray(post.format) ? post.format : [post.format || "Unknown"];
        for (const format of formats) {
            if (!formatCounts[format]) formatCounts[format] = {};
            formatCounts[format].no_of_posts = (formatCounts[format].no_of_posts || 0) + 1;
            formatCounts[format].category_total_likes = (formatCounts[format].category_total_likes || 0) + (isNaN(parseLikes(post.likes)) ? 0 : parseLikes(post.likes));
            formatCounts[format].category_total_comments = (formatCounts[format].category_total_comments || 0) + (isNaN(parseLikes(post.comments)) ? 0 : parseLikes(post.comments));
        }
    }

    for (const intent in intentCounts) {
        intentCounts[intent].category_avg_likes = avgLikes !== "N/A" ? (intentCounts[intent].category_total_likes / intentCounts[intent].no_of_posts) : "N/A";
        intentCounts[intent].category_avg_comments = avgComments !== "N/A" ? (intentCounts[intent].category_total_comments / intentCounts[intent].no_of_posts) : "N/A";
        
        let relativePerformanceLikes = "N/A";
        if (avgLikes !== "N/A" && intentCounts[intent].category_avg_likes !== "N/A") {
            if (avgLikes === 0) {
                relativePerformanceLikes = intentCounts[intent].category_avg_likes === 0 ? 0 : (intentCounts[intent].category_avg_likes > 0 ? Infinity : -Infinity);
            } else {
                relativePerformanceLikes = ((intentCounts[intent].category_avg_likes - avgLikes) / avgLikes) * 100;
            }
        }

        let relativePerformanceComments = "N/A";
        if (avgComments !== "N/A" && intentCounts[intent].category_avg_comments !== "N/A") {
            if (avgComments === 0) {
                relativePerformanceComments = intentCounts[intent].category_avg_comments === 0 ? 0 : (intentCounts[intent].category_avg_comments > 0 ? Infinity : -Infinity);
            } else {
                relativePerformanceComments = ((intentCounts[intent].category_avg_comments - avgComments) / avgComments) * 100;
            }
        }

        intentCounts[intent].relative_performance = {
            likes: relativePerformanceLikes !== "N/A" ? (relativePerformanceLikes === Infinity ? "Infinity%" : relativePerformanceLikes === -Infinity ? "-Infinity%" : relativePerformanceLikes.toFixed(2) + "%") : "N/A",
            comments: relativePerformanceComments !== "N/A" ? (relativePerformanceComments === Infinity ? "Infinity%" : relativePerformanceComments === -Infinity ? "-Infinity%" : relativePerformanceComments.toFixed(2) + "%") : "N/A",
        };
    }

    for (const format in formatCounts) {
        formatCounts[format].category_avg_likes = avgLikes !== "N/A" ? (formatCounts[format].category_total_likes / formatCounts[format].no_of_posts) : "N/A";
        formatCounts[format].category_avg_comments = avgComments !== "N/A" ? (formatCounts[format].category_total_comments / formatCounts[format].no_of_posts) : "N/A";
        
        let relativePerformanceLikes = "N/A";
        if (avgLikes !== "N/A" && formatCounts[format].category_avg_likes !== "N/A") {
            if (avgLikes === 0) {
                relativePerformanceLikes = formatCounts[format].category_avg_likes === 0 ? 0 : (formatCounts[format].category_avg_likes > 0 ? Infinity : -Infinity);
            } else {
                relativePerformanceLikes = ((formatCounts[format].category_avg_likes - avgLikes) / avgLikes) * 100;
            }
        }

        let relativePerformanceComments = "N/A";
        if (avgComments !== "N/A" && formatCounts[format].category_avg_comments !== "N/A") {
            if (avgComments === 0) {
                relativePerformanceComments = formatCounts[format].category_avg_comments === 0 ? 0 : (formatCounts[format].category_avg_comments > 0 ? Infinity : -Infinity);
            } else {
                relativePerformanceComments = ((formatCounts[format].category_avg_comments - avgComments) / avgComments) * 100;
            }
        }

        formatCounts[format].relative_performance = {
            likes: relativePerformanceLikes !== "N/A" ? (relativePerformanceLikes === Infinity ? "Infinity%" : relativePerformanceLikes === -Infinity ? "-Infinity%" : relativePerformanceLikes.toFixed(2) + "%") : "N/A",
            comments: relativePerformanceComments !== "N/A" ? (relativePerformanceComments === Infinity ? "Infinity%" : relativePerformanceComments === -Infinity ? "-Infinity%" : relativePerformanceComments.toFixed(2) + "%") : "N/A",
        };
    }

    delete intentCounts["category_total_likes"];
    delete intentCounts["category_total_comments"];
    delete formatCounts["category_total_likes"];
    delete formatCounts["category_total_comments"];

    return {
        intentDistribution: intentCounts,
        formatDistribution: formatCounts,
    };
}

function getAnalysisInsights(analysis) {
    let globalIntentPerformance = {};
    let globalFormatPerformance = {};

    function parsePercent(val) {
        if (!val || val === "N/A") return null;
        if (val === "Infinity%") return Infinity;
        if (val === "-Infinity%") return -Infinity;
        return parseFloat(val.replace("%", ""));
    }

    function calculateMedian(arr) {
        const filtered = arr.filter(n => n !== Infinity && n !== -Infinity);
        if (filtered.length === 0) return null;
        const sorted = [...filtered].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    const totalAccounts = Object.keys(analysis).length;

    for (const account in analysis) {
        const accountData = analysis[account];
        const intentDist = accountData.intentDistribution || {};
        const formatDist = accountData.formatDistribution || {};

        for (const intent in intentDist) {
            if (!globalIntentPerformance[intent]) globalIntentPerformance[intent] = { likes: [], comments: [], wins: { likes: 0, comments: 0 } };
            const perf = intentDist[intent].relative_performance;
            if (perf) {
                const likes = parsePercent(perf.likes);
                const comments = parsePercent(perf.comments);
                if (likes !== null && !isNaN(likes)) {
                    globalIntentPerformance[intent].likes.push(likes);
                    if (likes > 0) globalIntentPerformance[intent].wins.likes++;
                }
                if (comments !== null && !isNaN(comments)) {
                    globalIntentPerformance[intent].comments.push(comments);
                    if (comments > 0) globalIntentPerformance[intent].wins.comments++;
                }
            }
        }

        for (const format in formatDist) {
            if (!globalFormatPerformance[format]) globalFormatPerformance[format] = { likes: [], comments: [], wins: { likes: 0, comments: 0 } };
            const perf = formatDist[format].relative_performance;
            if (perf) {
                const likes = parsePercent(perf.likes);
                const comments = parsePercent(perf.comments);
                if (likes !== null && !isNaN(likes)) {
                    globalFormatPerformance[format].likes.push(likes);
                    if (likes > 0) globalFormatPerformance[format].wins.likes++;
                }
                if (comments !== null && !isNaN(comments)) {
                    globalFormatPerformance[format].comments.push(comments);
                    if (comments > 0) globalFormatPerformance[format].wins.comments++;
                }
            }
        }
    }

    function aggregate(performanceDict) {
        let result = {};
        for (const key in performanceDict) {
            const likesArrFiltered = performanceDict[key].likes.filter(n => n !== Infinity && n !== -Infinity);
            const commentsArrFiltered = performanceDict[key].comments.filter(n => n !== Infinity && n !== -Infinity);

            const avgLikes = likesArrFiltered.length > 0 ? likesArrFiltered.reduce((a, b) => a + b, 0) / likesArrFiltered.length : null;
            const avgComments = commentsArrFiltered.length > 0 ? commentsArrFiltered.reduce((a, b) => a + b, 0) / commentsArrFiltered.length : null;

            const medianLikes = calculateMedian(performanceDict[key].likes);
            const medianComments = calculateMedian(performanceDict[key].comments);
            
            const winRateLikes = totalAccounts > 0 ? (performanceDict[key].wins.likes / totalAccounts) * 100 : 0;
            const winRateComments = totalAccounts > 0 ? (performanceDict[key].wins.comments / totalAccounts) * 100 : 0;

            result[key] = {
                global_relative_performance_average: {
                    likes: avgLikes !== null ? avgLikes.toFixed(2) + "%" : "N/A",
                    comments: avgComments !== null ? avgComments.toFixed(2) + "%" : "N/A"
                },
                global_relative_performance_median: {
                    likes: medianLikes !== null ? medianLikes.toFixed(2) + "%" : "N/A",
                    comments: medianComments !== null ? medianComments.toFixed(2) + "%" : "N/A"
                },
                account_relative_win_rate: {
                    likes: winRateLikes.toFixed(2) + "%",
                    comments: winRateComments.toFixed(2) + "%"
                }
            };
        }
        return result;
    }

    return {
        intent_insights: aggregate(globalIntentPerformance),
        format_insights: aggregate(globalFormatPerformance)
    };
}

function getAdditionalInsights(analysis, rawData) {
    let analysisArray = Object.entries(analysis).map(([account, data]) => ({
        account,
        ...data
    }));
    analysisArray.sort((a, b) => b.averageLikesComments.avgLikes - a.averageLikesComments.avgLikes);
    let topPerformer = analysisArray[0];
    let topPerformerFrequency = topPerformer ? topPerformer.averageTimeBetweenPostsReadable : "N/A";

    let totalReelLikes = 0;
    let reelCount = 0;
    let totalPostLikes = 0;
    let postCount = 0;

    for (const account in rawData) {
        for (const post of rawData[account]) {
            if (post.likes && post.likes !== "N/A") {
                let likes = parseLikes(post.likes);
                if (!isNaN(likes)) {
                    if (post.type === "reel") {
                        totalReelLikes += likes;
                        reelCount++;
                    } else if (post.type === "post") {
                        totalPostLikes += likes;
                        postCount++;
                    }
                }
            }
        }
    }

    let avgReelLikes = reelCount > 0 ? totalReelLikes / reelCount : 0;
    let avgPostLikes = postCount > 0 ? totalPostLikes / postCount : 0;
    
    let reelsPerformanceOverPosts = "N/A";
    if (avgPostLikes > 0) {
        reelsPerformanceOverPosts = (((avgReelLikes - avgPostLikes) / avgPostLikes) * 100).toFixed(2) + "%";
    } else if (avgReelLikes > 0 && avgPostLikes === 0) {
        reelsPerformanceOverPosts = "Infinity%";
    } else if (avgReelLikes === 0 && avgPostLikes === 0) {
        reelsPerformanceOverPosts = "0.00%";
    }

    return {
        topPerformer: {
            account: topPerformer ? topPerformer.account : "Unknown",
            frequency: topPerformerFrequency
        },
        reelsPerformanceOverPosts: reelsPerformanceOverPosts
    };
}

function analyseData(rawData) {
    let analysis = {};

    for (const account in rawData) {
        const posts = rawData[account];
        let { intentDistribution: intentCounts, formatDistribution: formatCounts } = getCategoryDistribution(posts);

        const avgTimeBetweenPostsReadable = calculateAverageTimeBetweenPosts(posts);

        analysis[account] = {
            averageLikesComments: getAvgLikesComments(posts),
            totalPosts: posts.length,
            intentDistribution: intentCounts,
            formatDistribution: formatCounts,
            averageTimeBetweenPostsReadable: avgTimeBetweenPostsReadable,
        };
    }
    
    let global_insights = getAnalysisInsights(analysis);
    let additional_insights = getAdditionalInsights(analysis, rawData);

    return {
        ...global_insights,
        ...additional_insights
    };
}

async function generateExcelFile(analysisOptions) {
  // Convert to XLSX using exceljs for styling and spacing
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Insights");

  // Define columns with custom widths
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

  // Header styling
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };

  let currentRow = 2; // Row 1 is header

  if (analysisOptions.intent_insights) {
      const intentEntries = Object.entries(analysisOptions.intent_insights);
      if (intentEntries.length > 0) {
          const startRow = currentRow;
          for (const [intent, data] of intentEntries) {
              const row = worksheet.addRow({
                  type: "Intent",
                  name: intent,
                  avgLikes: data.global_relative_performance_average.likes,
                  avgComments: data.global_relative_performance_average.comments,
                  medLikes: data.global_relative_performance_median.likes,
                  medComments: data.global_relative_performance_median.comments,
                  winLikes: data.account_relative_win_rate.likes,
                  winComments: data.account_relative_win_rate.comments
              });

              // Apply light blue shading for intent rows
              row.eachCell((cell) => {
                  cell.fill = {
                      type: "pattern",
                      pattern: "solid",
                      fgColor: { argb: "FFD9E1F2" } // Light blue
                  };
              });

              currentRow++;
          }
          if (currentRow - 1 >= startRow) {
              worksheet.mergeCells(`A${startRow}:A${currentRow - 1}`);
              const typeCell = worksheet.getCell(`A${startRow}`);
              typeCell.alignment = { horizontal: "center", vertical: "middle" };
          }
      }
  }

  if (analysisOptions.format_insights) {
      const formatEntries = Object.entries(analysisOptions.format_insights);
      if (formatEntries.length > 0) {
          const startRow = currentRow;
          for (const [format, data] of formatEntries) {
              const row = worksheet.addRow({
                  type: "Format",
                  name: format,
                  avgLikes: data.global_relative_performance_average.likes,
                  avgComments: data.global_relative_performance_average.comments,
                  medLikes: data.global_relative_performance_median.likes,
                  medComments: data.global_relative_performance_median.comments,
                  winLikes: data.account_relative_win_rate.likes,
                  winComments: data.account_relative_win_rate.comments
              });

              // Apply light orange shading for format rows
              row.eachCell((cell) => {
                  cell.fill = {
                      type: "pattern",
                      pattern: "solid",
                      fgColor: { argb: "FFFCE4D6" } // Light orange
                  };
              });

              currentRow++;
          }
          if (currentRow - 1 >= startRow) {
              worksheet.mergeCells(`A${startRow}:A${currentRow - 1}`);
              const typeCell = worksheet.getCell(`A${startRow}`);
              typeCell.alignment = { horizontal: "center", vertical: "middle" };
          }
      }
  }

  await workbook.xlsx.writeFile("global_insights.xlsx");
  console.log("Saved insights to global_insights.xlsx with wide columns, matched alignment, and shaded rows");
}

(async function main() {
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    storageState: "state.json",
  });

  const page = await context.newPage();

  let rawData = {};

  for (const account of accounts) {
    let postData = await getAccountPosts(page, account, maxPosts);

    for (let i = 0; i < postData.length; i++) {
      postData[i] = await extractPostData(context, postData[i]);
    }

    console.log(postData);

    rawData[account] = postData;
  }

  await browser.close();

  const analysisOptions = analyseData(rawData);
  console.log("Analysis Output:", JSON.stringify(analysisOptions, null, 2));

  await generateExcelFile(analysisOptions);
})();
