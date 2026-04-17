import fs from "fs";
import dotenv from "dotenv";
import { chromium } from "playwright";
import https from "https";

dotenv.config();

const maxPosts = 2;
const accounts = ["nike", "plaeto.schools"];

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
    "Storytelling",
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
  const posts = await page.locator('a[href*="/p/"], a[href*="/reel/"]').all();

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

function analyseData(rawData) {
    let analysis = {};

    for (const account in rawData) {
        const posts = rawData[account];
        const intentCounts = {};
        const formatCounts = {};

        for (const post of posts) {
            for (const intent of post.intent) {
                intentCounts[intent] = (intentCounts[intent] || 0) + 1;
            }
            for (const format of post.format) {
                formatCounts[format] = (formatCounts[format] || 0) + 1;
            }
        }

        const avgTimeBetweenPostsReadable = calculateAverageTimeBetweenPosts(posts);

        analysis[account] = {
            totalPosts: posts.length,
            intentDistribution: intentCounts,
            formatDistribution: formatCounts,
            averageTimeBetweenPostsReadable: avgTimeBetweenPostsReadable,
        };
    }
    return analysis;
}

(async function main() {
  const browser = await chromium.launch({
    headless: false,
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
})();
