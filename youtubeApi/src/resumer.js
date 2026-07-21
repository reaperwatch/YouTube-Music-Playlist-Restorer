const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const crypto = require("crypto");

// Settings for the resume process
const EXISTING_PLAYLIST_ID = "PLYzNd0ybnG7Kz5PKnUdMJ2IDibSl5wEZy";
const START_INDEX = 1328;
const BATCH_SIZE = 5;

function getAuthHeader(cookieStr) {
  const match = cookieStr.match(/SAPISID=([^;]+)/);
  if (!match) return "";
  const time = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHash("sha1")
    .update(`${time} ${match[1]} https://music.youtube.com`)
    .digest("hex");
  return `SAPISIDHASH ${time}_${hash}`;
}

async function resumeRestore() {
  try {
    const cookiePath = path.join(__dirname, "cookie.txt");
    const csvPath = path.join(__dirname, "Favorite tracks_1.csv");

    if (!fs.existsSync(cookiePath)) throw new Error("Missing cookie.txt");
    const USER_COOKIE = fs.readFileSync(cookiePath, "utf8").trim();
    const authHeader = getAuthHeader(USER_COOKIE);

    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      cookie: USER_COOKIE,
      origin: "https://music.youtube.com",
      authorization: authHeader,
      "x-youtube-client-name": "67",
      "x-youtube-client-version": "1.20260318.00.00",
    };

    const baseContext = {
      client: { clientName: "WEB_REMIX", clientVersion: "1.20260318.00.00" },
    };

    const videoIds = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on("data", (row) => {
          const id = row["YouTube Video ID"];
          if (id) videoIds.push(id);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    const total = videoIds.length;
    console.log(`♻️  Resuming from track ${START_INDEX} of ${total}...`);
    console.log(`Target Playlist: ${EXISTING_PLAYLIST_ID}\n`);

    for (let i = START_INDEX; i < total; i += BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + BATCH_SIZE);
      const actions = chunk.map((id) => ({
        action: "ACTION_ADD_VIDEO",
        addedVideoId: id,
      }));

      const editRes = await fetch(
        "https://music.youtube.com/youtubei/v1/browse/edit_playlist?prettyPrint=false",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            context: baseContext,
            playlistId: EXISTING_PLAYLIST_ID,
            actions: actions,
          }),
        },
      );

      if (!editRes.ok) {
        const errorText = await editRes.text();
        throw new Error(
          `YouTube API returned ${editRes.status}. Body: ${errorText.substring(0, 50)}`,
        );
      }

      const editData = await editRes.json();

      if (editData.status === "FAILED") {
        console.error(`⚠️  API Error at batch starting at track ${i}.`);
      } else {
        console.log(
          `🚀 Progress: [${Math.min(i + BATCH_SIZE, total)}/${total}] tracks added...`,
        );
      }

      // RANDOM DELAY: 5 to 30 seconds
      const randomDelay = Math.floor(Math.random() * (30000 - 5000 + 1) + 5000);
      await new Promise((r) => setTimeout(r, randomDelay));
    }

    console.log("\n🎊 Success! The remaining tracks have been added.");
  } catch (err) {
    console.error("❌ Resume Error:", err.message);
  }
}

resumeRestore();
