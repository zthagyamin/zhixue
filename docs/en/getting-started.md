# Get started with Zhixue

[简体中文](../zh-CN/getting-started.md) · [README](../../README.md) · [FAQ](FAQ.md)

The interface is currently primarily Chinese. This guide names the Chinese labels you will see. Start with one short, non-sensitive material rather than connecting your entire collection.

## 1. Try a note in the browser

Open the [learning workspace](https://zhixue-daily.zthagyamin.chatgpt.site/study). Follow the site's sign-in prompt where required; completing a tutorial or seeing a demonstration does not connect your personal library.

Expand **“用自己的笔记试学”**. Choose one or two UTF-8 Markdown/TXT files (up to 256 KB each), or paste a complete paragraph. Explicit question/answer text such as `Q: ...` and `A: ...` can make the intended task clearer.

The trial extracts up to three recall prompts locally. It does not call a model, upload the selected text, or write formal study records. Text extraction is not an endorsement of question quality; check that a prompt is worth practicing.

Write your answer before choosing **“查看原文并自评”**. Mark an unfamiliar item for another attempt, or continue. At the end, retry only the marked items if useful.

Trial answers and retry marks are page-session data: leaving or reloading does not retain them. After finishing, use the separate material-saving action if you want to reopen the questions later. Saved trial materials remain in this browser and do not automatically enter Obsidian, the account library, or the formal daily plan. Keep the original file and use the available material backup controls before changing devices.

## 2. Connect ongoing sources, if needed

For local source access and writeback, the supported packaged workflow uses **Windows x64 Companion**. Obsidian is optional; an ordinary note folder is also a source. Browser file selection alone does not grant Companion ongoing access.

Consult the existing website's [Companion guide](https://zhixue-daily.zthagyamin.chatgpt.site/companion-guide) for its package-specific installation instructions. This open-source checkout does not include a certified binary release. If a separate release is provided, verify its version, distribution notice, and checksum. Do not disable operating-system protections to make a package run.

Once Companion is running:

1. Keep its window open; it may be minimized.
2. Sign into the intended website account and open the connection/settings area.
3. Enter the current one-time pairing code shown by Companion when requested.
4. Check that the page reports a ready local connection.
5. In **“连接你的笔记”**, select one small source, preview it, and confirm the intended import.

Installation, pairing, and source registration are separate states. Seeing examples after pairing does not prove your own material was imported. Do not change accounts or delete data as a shortcut to repair a connection.

Supported source paths include local notes and selected readable files; formats and size limits vary by importer. PDF text extraction is not OCR. For Notion, explicitly authorize the selected pages; a public link or browser login alone is not API authorization. Notion writeback requires a separately selected learning-record parent page and its permissions.

## 3. Confirm the learning content

Inspect source titles, questions, and reference answers. A imported document is not necessarily a ready exercise. Vague tasks, missing answers, extraction errors, and invalid source bindings should be corrected before relying on grades.

Use **“今日”** for daily arrangements and **“按学科学习”** to choose content yourself. Long-term plan settings and the available registered learning pool influence today's tasks. The study-day boundary is 04:00 in the configured study timezone; check your setup before interpreting overnight records.

Answer first, inspect feedback, and retry what needs correction. First attempts, supported attempts, remediation, and pending evaluation are distinct; completing a round is not proof of long-term mastery.

## 4. Enable AI only when you need it

Open **“AI 与 API Key 设置”**, choose a supported provider/model, and review its API address and usage limits. The included choices are DeepSeek and OpenAI API. A ChatGPT website subscription does not supply API credits.

Enabling AI requires acknowledging that your question and quoted context will be sent to that API and may incur charges. Account-mode and local-mode keys have separate storage: the account service encrypts its key; local Companion uses the system credential store. Do not paste keys into chat, notes, screenshots, or issue reports.

A connection test makes an actual model call with a fixed test message, not the current learning page. It is not a grading-quality test. If an exercise cannot be reliably evaluated, a pending result is not a failed answer.

Without an API key you can still use supported non-AI paths, including the note trial. Copying the optional tutor prompt only places text on the clipboard; sending it to a separate AI website is your own next action.

## 5. Read the save status before leaving

**“已保存”**, **“待同步”**, and **“已写回”** describe different destinations. Saving a browser draft does not prove cloud synchronization or source writeback.

If saving fails, keep the page open and copy your input before retrying. Do not clear website storage while there are pending records. Use supported exports/backups before switching browsers or devices. Closing Companion pauses local operations; it does not erase the distinction between local and cloud state.

## Need help?

Read the [FAQ](FAQ.md) or the website's [help page](https://zhixue-daily.zthagyamin.chatgpt.site/help). For an issue, include version, platform, entry point, steps, expected/actual result, and a minimal synthetic example. Remove private materials and credentials.

For running source code rather than using the hosted service, see [development](development.md). Self-hosted production identity and account services require additional integration; a local mock login is not production authentication.
