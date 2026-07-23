# YouTube Music Playlist Restorer

Automated tool to convert CSV song exports into YouTube Music playlists with batch processing and automatic state saving.

---

## 1. Installation

Ensure you have **Node.js** installed, then run (inside the youtubeApi folder, for all scripts as well!):

```bash
npm install

```

---

## 2. Setup

1. **Log in:** Make sure you are logged into [YouTube Music](https://music.youtube.com) in your web browser (and close the browser before running the scripts).
2. **Add CSVs:** Drop your `.csv` file(s) into the youtubeApi folder of this project.

---

## 3. Usage

### Create a New Playlist

Run the main script to select a CSV, create the YouTube playlist, and automatically batch add all tracks:

```bash
node .

```

- _If multiple CSVs exist, you'll be prompted to pick one._
- _Progress and playlist state are automatically updated in `restore_state.json` after every batch._

### Resume Interrupted Tasks

If your script crashes, terminal closes, or rate limits stop the process, resume anytime from where you left off without creating duplicate playlists:

```bash
node src/resumer.js

```
