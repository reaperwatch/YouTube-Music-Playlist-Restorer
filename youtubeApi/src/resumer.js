const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const crypto = require("crypto");
const readline = require("readline/promises");

const BATCH_SIZE = 20;

function saveState(filePath, csvFilename, data) {
  let allStates = {};
  if (fs.existsSync(filePath)) {
    try {
      allStates = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      allStates = {};
    }
  }
  allStates[csvFilename] = data;
  fs.writeFileSync(filePath, JSON.stringify(allStates, null, 2), "utf8");
}

function removeStateKey(filePath, csvFilename) {
  if (!fs.existsSync(filePath)) return;
  try {
    const allStates = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (allStates[csvFilename]) {
      delete allStates[csvFilename];
      fs.writeFileSync(filePath, JSON.stringify(allStates, null, 2), "utf8");
    }
  } catch (e) {}
}

function getAuthHeader(cookieStr) {
  const match = cookieStr.match(
    /(?:__Secure-3PAPISID|__Secure-1PAPISID|SAPISID)=([^;]+)/,
  );
  if (!match) return "";
  const time = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHash("sha1")
    .update(`${time} ${match[1]} https://music.youtube.com`)
    .digest("hex");
  return `SAPISIDHASH ${time}_${hash}`;
}

const { getExtraChromiumProfiles } = require("./browser-paths");

async function extractYouTubeCookies(getCookies, toCookieHeader) {
  console.log(
    "🔍 Scanning default browsers (Chrome, Edge, Firefox, Safari)...",
  );
  let result = await getCookies({
    url: "https://music.youtube.com",
    origins: ["https://music.youtube.com", "https://youtube.com"],
    browsers: ["chrome", "edge", "firefox", "safari"],
  });

  let rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
  if (/(?:SAPISID|PAPISID)=/.test(rawCookie)) return rawCookie;

  if (process.platform === "darwin") {
    console.log("🔍 Scanning macOS Brave/Arc installations...");
    for (const bg of ["brave", "arc"]) {
      result = await getCookies({
        url: "https://music.youtube.com",
        origins: ["https://music.youtube.com", "https://youtube.com"],
        browsers: ["chrome"],
        chromiumBrowser: bg,
      });
      rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
      if (/(?:SAPISID|PAPISID)=/.test(rawCookie)) return rawCookie;
    }
  }

  const extraProfiles = await getExtraChromiumProfiles();
  for (const item of extraProfiles) {
    console.log(`🔍 Checking profile: ${item.name} in ${item.path}...`);
    try {
      result = await getCookies({
        url: "https://music.youtube.com",
        origins: ["https://music.youtube.com", "https://youtube.com"],
        browsers: ["chrome"],
        chromeProfile: item.path,
        chromiumBrowser: item.chromiumBrowser,
      });
      rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
      if (/(?:SAPISID|PAPISID)=/.test(rawCookie)) return rawCookie;
    } catch (_) {}
  }

  return "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function addBatchChecked(
  url,
  getHeaders,
  baseContext,
  playlistId,
  chunk,
) {
  const actions = chunk.map((id) => ({
    action: "ACTION_ADD_VIDEO",
    addedVideoId: id,
    dedupeOption: "DEDUPE_OPTION_SKIP",
  }));

  const MAX_ATTEMPTS = 5;
  let reason = "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ context: baseContext, playlistId, actions }),
      });

      if (res.status === 404) {
        return {
          ok: false,
          fatal: true,
          notFound: true,
          reason: "playlist not found (404)",
        };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          fatal: true,
          reason: `HTTP ${res.status} (session/cookies rejected)`,
        };
      }

      let data = null;
      try {
        data = await res.json();
      } catch (_) {}

      if (res.ok && data && data.status === "STATUS_SUCCEEDED") {
        return { ok: true };
      }

      reason = `HTTP ${res.status}, status=${data?.status ?? "n/a"}`;
      console.log(
        `   ⚠️ Batch rejected (${reason}). Attempt ${attempt}/${MAX_ATTEMPTS}`,
      );
      if (data && !data.status) {
        console.log("   Response:", JSON.stringify(data).slice(0, 300));
      }
    } catch (err) {
      reason = `network error: ${err.message}`;
      console.log(`   ⚠️ ${reason}. Attempt ${attempt}/${MAX_ATTEMPTS}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      const wait = 30000 * 2 ** (attempt - 1); // 30s, 60s, 120s, 240s
      console.log(`   ⏱️ Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  return { ok: false, fatal: false, reason };
}

async function selectStateToResume(stateFilePath, getHeaders, baseContext) {
  if (!fs.existsSync(stateFilePath)) {
    throw new Error(
      "No restore_state.json found in the current directory. Start a new playlist first!",
    );
  }

  let allStates = {};
  try {
    allStates = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
  } catch (e) {
    throw new Error("Could not parse restore_state.json.");
  }

  let stateModified = false;
  for (const [filename, data] of Object.entries(allStates)) {
    if (data.completed) {
      console.log(
        `🧹 Purging completed entry for '${filename}' from state file...`,
      );
      delete allStates[filename];
      stateModified = true;
    }
  }

  if (stateModified) {
    fs.writeFileSync(stateFilePath, JSON.stringify(allStates, null, 2), "utf8");
  }

  const incompleteStates = Object.entries(allStates);

  if (incompleteStates.length === 0) {
    console.log(
      "✨ No incomplete playlists found to resume (completed entries were cleaned up).",
    );
    process.exit(0);
  }

  console.log("🔍 Verifying active playlists on YouTube...");
  const validStates = [];

  for (const [filename, data] of incompleteStates) {
    try {
      const checkRes = await fetch(
        "https://music.youtube.com/youtubei/v1/browse/edit_playlist",
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            context: baseContext,
            playlistId: data.playlistId,
            actions: [],
          }),
        },
      );

      if (checkRes.status === 404) {
        console.log(
          `🗑️ Playlist for '${filename}' (${data.playlistId}) no longer exists on YouTube. Auto-cleaning state...`,
        );
        delete allStates[filename];
        fs.writeFileSync(
          stateFilePath,
          JSON.stringify(allStates, null, 2),
          "utf8",
        );
        continue;
      }

      validStates.push([filename, data]);
    } catch (err) {
      validStates.push([filename, data]);
    }
  }

  if (validStates.length === 0) {
    console.log(
      "✨ No active incomplete playlists remaining (deleted or completed playlists were cleaned up).",
    );
    process.exit(0);
  }

  if (validStates.length === 1) {
    const [filename, data] = validStates[0];
    console.log(
      `\n📄 Found one incomplete restore: ${filename} (${data.tracksAdded}/${data.totalTracks} tracks, ${(data.failedVideoIds || []).length} to retry). Auto-selecting...`,
    );
    return { filename, data };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    "\n📄 Multiple incomplete playlists found. Which one do you want to resume?",
  );
  validStates.forEach(([filename, data], index) => {
    console.log(
      `  [${index + 1}] ${filename} - Progress: ${data.tracksAdded}/${data.totalTracks}, ${(data.failedVideoIds || []).length} to retry`,
    );
  });

  while (true) {
    const answer = await rl.question(
      `\nEnter a number (1-${validStates.length}): `,
    );
    const choice = parseInt(answer.trim(), 10);

    if (!isNaN(choice) && choice >= 1 && choice <= validStates.length) {
      rl.close();
      const [filename, data] = validStates[choice - 1];
      console.log(`✅ Selected: ${filename}`);
      return { filename, data };
    } else {
      console.log("❌ Invalid choice. Try again.");
    }
  }
}

async function resumeRestore() {
  try {
    const currentDir = process.cwd();
    const stateFilePath = path.join(currentDir, "restore_state.json");

    const { getCookies, toCookieHeader } =
      await import("@steipete/sweet-cookie");
    console.log("🍪 Extracting YouTube Music session cookies...");
    const USER_COOKIE = await extractYouTubeCookies(getCookies, toCookieHeader);

    if (!USER_COOKIE)
      throw new Error("Could not find an active YouTube Music session cookie.");

    if (!getAuthHeader(USER_COOKIE))
      throw new Error("Could not find SAPISID in cookie.");

    const getHeaders = () => ({
      accept: "*/*",
      "content-type": "application/json",
      cookie: USER_COOKIE,
      origin: "https://music.youtube.com",
      authorization: getAuthHeader(USER_COOKIE),
      "x-goog-authuser": "0",
      "x-youtube-client-name": "67",
      "x-youtube-client-version": "1.20260318.00.00",
    });

    const baseContext = {
      client: { clientName: "WEB_REMIX", clientVersion: "1.20260318.00.00" },
    };

    const targetState = await selectStateToResume(
      stateFilePath,
      getHeaders,
      baseContext,
    );
    const { filename: csvFilename, data: stateData } = targetState;
    const csvPath = path.join(currentDir, csvFilename);

    let videoIds = [];

    if (
      stateData.resolvedVideoIds &&
      Array.isArray(stateData.resolvedVideoIds)
    ) {
      console.log(`\n📂 Found resolved video IDs in state file.`);
      videoIds = stateData.resolvedVideoIds;
    } else {
      if (!fs.existsSync(csvPath)) {
        throw new Error(
          `The CSV file '${csvFilename}' is missing from this directory, and no cached IDs were found!`,
        );
      }

      console.log(
        `\n📂 State file is missing 'resolvedVideoIds'. Falling back to parsing CSV...`,
      );
      await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
          .pipe(csv())
          .on("data", (row) => {
            const idKey = Object.keys(row).find((key) => key.includes("ID"));
            if (idKey && row[idKey]) videoIds.push(row[idKey].trim());
          })
          .on("end", resolve)
          .on("error", reject);
      });
    }

    const total = videoIds.length;
    let tracksAdded = stateData.tracksAdded;
    let failedVideoIds = Array.isArray(stateData.failedVideoIds)
      ? [...stateData.failedVideoIds]
      : [];
    let confirmedAdded =
      typeof stateData.confirmedAdded === "number"
        ? stateData.confirmedAdded
        : Math.max(0, tracksAdded - failedVideoIds.length);

    const editUrl =
      "https://music.youtube.com/youtubei/v1/browse/edit_playlist";
    const failedPath = path.join(currentDir, `failed_ids_${csvFilename}.json`);

    const persist = () => {
      saveState(stateFilePath, csvFilename, {
        playlistId: stateData.playlistId,
        tracksAdded: tracksAdded,
        confirmedAdded: confirmedAdded,
        failedVideoIds: failedVideoIds,
        totalTracks: total,
        completed: false,
        lastUpdated: new Date().toISOString(),
        resolvedVideoIds: videoIds,
      });
      if (failedVideoIds.length > 0) {
        fs.writeFileSync(
          failedPath,
          JSON.stringify(failedVideoIds, null, 2),
          "utf8",
        );
      } else if (fs.existsSync(failedPath)) {
        fs.unlinkSync(failedPath);
      }
    };

    const handleFatal = (result) => {
      if (result.notFound) {
        removeStateKey(stateFilePath, csvFilename);
        throw new Error(
          `Playlist '${stateData.playlistId}' was deleted on YouTube. Cleaned up state file entry. Run 'node .' to recreate it.`,
        );
      }
      throw new Error(
        `Aborting: ${result.reason}. Log in again and re-run 'node src/resumer.js'.`,
      );
    };

    console.log(
      `\n♻️  Resuming '${csvFilename}' from track ${tracksAdded} of ${total}...`,
    );
    console.log(`🎯 Target Playlist: ${stateData.playlistId}\n`);

    if (failedVideoIds.length > 0) {
      console.log(
        `🔁 Retrying ${failedVideoIds.length} track(s) that failed earlier...`,
      );
      const toRetry = failedVideoIds;
      failedVideoIds = [];

      for (let i = 0; i < toRetry.length; i += BATCH_SIZE) {
        const chunk = toRetry.slice(i, i + BATCH_SIZE);
        const result = await addBatchChecked(
          editUrl,
          getHeaders,
          baseContext,
          stateData.playlistId,
          chunk,
        );

        if (result.ok) {
          confirmedAdded += chunk.length;
        } else {
          failedVideoIds.push(...chunk);
          if (result.fatal) {
            failedVideoIds.push(...toRetry.slice(i + BATCH_SIZE));
            persist();
            handleFatal(result);
          }
          console.log(`❌ Retry batch still failing: ${result.reason}`);
        }

        persist();
        console.log(
          `🔁 Retried [${Math.min(i + BATCH_SIZE, toRetry.length)}/${toRetry.length}], ${failedVideoIds.length} still failing.`,
        );

        if (i + BATCH_SIZE < toRetry.length || tracksAdded < total) {
          const randomDelay = Math.floor(
            Math.random() * (30000 - 5000 + 1) + 5000,
          );
          console.log(
            `⏱️  Waiting ${randomDelay / 1000}s before next batch...`,
          );
          await sleep(randomDelay);
        }
      }
    }

    for (let i = tracksAdded; i < total; i += BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + BATCH_SIZE);
      const result = await addBatchChecked(
        editUrl,
        getHeaders,
        baseContext,
        stateData.playlistId,
        chunk,
      );

      if (!result.ok && result.fatal) {
        handleFatal(result);
      }

      if (result.ok) {
        confirmedAdded += chunk.length;
      } else {
        failedVideoIds.push(...chunk);
        console.log(
          `❌ Batch at [${i + 1}-${i + chunk.length}] FAILED: ${result.reason}`,
        );
      }

      tracksAdded = Math.min(i + BATCH_SIZE, total);
      persist();

      console.log(
        `🚀 Progress: [${tracksAdded}/${total}] processed, ${confirmedAdded} confirmed by YouTube.`,
      );

      if (tracksAdded < total) {
        const randomDelay = Math.floor(
          Math.random() * (30000 - 5000 + 1) + 5000,
        );
        console.log(`⏱️  Waiting ${randomDelay / 1000}s before next batch...`);
        await sleep(randomDelay);
      }
    }

    if (failedVideoIds.length === 0) {
      removeStateKey(stateFilePath, csvFilename);
      if (fs.existsSync(failedPath)) fs.unlinkSync(failedPath);
      console.log(
        `\n🎊 Success! ${csvFilename} has been fully restored and removed from state tracking.`,
      );
    } else {
      persist();
      console.log(
        `\n⚠️ Done, but ${failedVideoIds.length} track(s) could not be added. They're saved in ${failedPath} and in restore_state.json.\n💡 Run 'node src/resumer.js' again later to retry them.`,
      );
    }
  } catch (err) {
    console.error("\n❌ Resume Error:", err.message);
  }
}

resumeRestore();
