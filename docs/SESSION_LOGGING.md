# Session Logging Documentation

## Overview

The application automatically creates detailed logs for every session, capturing the complete conversation history, user interactions, and session metadata. Each session generates both a human-readable text log and a structured JSON log.

---

## Automatic Session Creation

### When Sessions Are Created
- **Automatically on app startup** - A new session starts when you launch the application
- **Automatically on app close** - The session is finalized with statistics when you quit

### Session ID
Each session gets a unique UUID identifier (e.g., `3f8a9b2c-4d1e-4f89-a1b2-c3d4e5f6g7h8`)

---

## Log File Formats

### Text Logs (`session_YYYY-MM-DDTHH-MM-SS.txt`)

Human-readable format with:
- **Header** with session ID, start time, and profile information
- **Timestamped messages** with role indicators (👤 USER, 🤖 ASSISTANT)
- **Event markers** for actions (🎤 monitoring started, 📸 screenshot captured, etc.)
- **Session summary** with duration and statistics at the end

#### Example Text Log:
```
╔════════════════════════════════════════════════════════════════════════════════╗
║                          INTERVIEW SESSION LOG                                  ║
╚════════════════════════════════════════════════════════════════════════════════╝

Session ID: 3f8a9b2c-4d1e-4f89-a1b2-c3d4e5f6g7h8
Start Time: 10/20/2025, 3:45:32 PM
Mode: Interview Practice & Transparent Assist

Profile Information:
- Job Title: Senior Software Engineer
- Job Description: Full-stack development with React and Node.js

═══════════════════════════════════════════════════════════════════════════════

[3:45:35 PM] 🎤 Audio monitoring started

[3:46:12 PM] 👤 USER (audio_transcription)
Tell me about a time you faced a challenging bug

────────────────────────────────────────────────────────────────────────────────

[3:46:15 PM] 🤖 ASSISTANT (text_response)
**Situation:** In my previous role at XYZ Corp, I encountered a production bug...
...

────────────────────────────────────────────────────────────────────────────────

╔════════════════════════════════════════════════════════════════════════════════╗
║                          SESSION SUMMARY                                        ║
╚════════════════════════════════════════════════════════════════════════════════╝

End Time: 10/20/2025, 4:12:18 PM
Duration: 26m 46s

Statistics:
- Total Messages: 24
- User Messages: 12
- Assistant Messages: 12
- Screenshots Analyzed: 3
- Tokens Used: 8,432

═══════════════════════════════════════════════════════════════════════════════

Session ended successfully.
```

---

### JSON Logs (`session_YYYY-MM-DDTHH-MM-SS.json`)

Structured data format with complete session information:

```json
{
  "sessionId": "3f8a9b2c-4d1e-4f89-a1b2-c3d4e5f6g7h8",
  "startTime": "2025-10-20T15:45:32.123Z",
  "endTime": "2025-10-20T16:12:18.456Z",
  "mode": "interview",
  "profile": {
    "jobTitle": "Senior Software Engineer",
    "jobDescription": "Full-stack development...",
    "candidateInfo": "...",
    "projects": "..."
  },
  "messages": [
    {
      "role": "user",
      "content": "Tell me about a time you faced a challenging bug",
      "timestamp": "2025-10-20T15:46:12.789Z",
      "type": "audio_transcription"
    },
    {
      "role": "assistant",
      "content": "**Situation:** In my previous role...",
      "timestamp": "2025-10-20T15:46:15.123Z",
      "type": "text_response"
    }
  ],
  "statistics": {
    "totalMessages": 24,
    "userMessages": 12,
    "assistantMessages": 12,
    "screenshotsAnalyzed": 3,
    "tokensUsed": 8432
  },
  "textLogPath": "C:\\Users\\...\\my-electron-app\\interview_logs\\session_2025-10-20T15-45-32.txt",
  "jsonLogPath": "C:\\Users\\...\\my-electron-app\\interview_logs\\session_2025-10-20T15-45-32.json",
  "lastSaved": "2025-10-20T16:12:18.500Z"
}
```

---

## What Gets Logged

### Conversation Messages
- ✅ User transcriptions from audio (tagged as `audio_transcription`)
- ✅ User screenshots (tagged as `screenshot`)
- ✅ AI text responses (tagged as `text_response`)
- ✅ AI image analyses (tagged as `image_analysis`)
- ✅ Full message content with timestamps

### Session Events
- ✅ Monitoring started/stopped
- ✅ Screenshot captures
- ✅ Mode changes (interview ↔ coding)
- ✅ Conversation cleared

### Session Statistics
- ✅ Message counts (total, user, assistant)
- ✅ Screenshots analyzed count
- ✅ Token usage
- ✅ Session duration
- ✅ Start and end times

### Profile Information
- ✅ Job title and description
- ✅ Candidate information
- ✅ Relevant projects
- ✅ Captured at session start

---

## Log Storage

### Location
- **Windows:** `%AppData%\my-electron-app\interview_logs\`
- **macOS:** `~/Library/Application Support/my-electron-app/interview_logs/`
- **Linux:** `~/.config/my-electron-app/interview_logs/`

### File Naming Convention
- Text: `session_YYYY-MM-DDTHH-MM-SS.txt`
- JSON: `session_YYYY-MM-DDTHH-MM-SS.json`

Example:
- `session_2025-10-20T15-45-32.txt`
- `session_2025-10-20T15-45-32.json`

---

## Automatic Maintenance

### Auto-Save
- JSON logs are saved automatically every 5 messages
- Final save occurs when session ends
- Prevents data loss if app crashes

### Auto-Cleanup
- Runs automatically on app startup
- Deletes logs older than 30 days
- Configurable in `main.js` (search for `maxAge`)

### Manual Cleanup
```javascript
// In console or via IPC
await window.electronAPI.cleanupOldLogs();
```

---

## Session Management API

### Get Current Session Info
```javascript
const session = await window.electronAPI.getSessionInfo();
console.log(session.sessionId);
console.log(session.statistics.totalMessages);
```

### End Current Session
```javascript
await window.electronAPI.endSession();
```

### Start New Session
```javascript
await window.electronAPI.startNewSession();
// Automatically ends current session if one exists
```

---

## UI Integration

### Status Bar Indicator
The status bar shows:
- 📝 Session icon
- First 8 characters of session ID
- Elapsed time in minutes
- Hover for full details (ID, start time, message count, log path)

Example: `📝 Session: 3f8a9b2c (26m)`

### Help Modal
The help modal (? button) includes a "Session Logs" section explaining:
- What gets logged
- Log formats
- Storage location
- Auto-cleanup policy

---

## Privacy & Security

### What's NOT Logged
- ❌ API keys or credentials
- ❌ System passwords
- ❌ Audio recordings (only transcriptions)
- ❌ Screenshot images (only analyses)

### What IS Logged
- ✅ Transcribed text from audio
- ✅ AI-generated responses
- ✅ Screenshot analysis text
- ✅ Profile information you provide
- ✅ Session metadata and statistics

### Local Storage Only
- All logs stored locally on your machine
- No cloud sync or external transmission
- You control the files entirely

---

## Use Cases

### Review Your Performance
- Read text logs to review your interview answers
- Identify patterns in your responses
- Track improvement over time

### Share with Mentors
- Export JSON logs for programmatic analysis
- Share text logs for human review
- Redact sensitive information before sharing

### Analyze with Scripts
- Parse JSON logs with custom scripts
- Generate statistics across multiple sessions
- Build custom dashboards or reports

### Debug Issues
- Check if transcriptions are accurate
- Verify AI responses quality
- Diagnose audio capture problems

---

## Advanced: Parsing JSON Logs

### Python Example
```python
import json
from datetime import datetime

with open('session_2025-10-20T15-45-32.json') as f:
    session = json.load(f)

print(f"Session Duration: {session['statistics']['totalMessages']} messages")
print(f"Token Efficiency: {session['statistics']['tokensUsed'] / session['statistics']['totalMessages']:.1f} tokens/message")

# Extract all user questions
questions = [msg['content'] for msg in session['messages'] if msg['role'] == 'user']
for i, q in enumerate(questions, 1):
    print(f"{i}. {q}")
```

### JavaScript Example
```javascript
const fs = require('fs');

const session = JSON.parse(fs.readFileSync('session_2025-10-20T15-45-32.json'));

// Calculate response times
for (let i = 0; i < session.messages.length - 1; i++) {
    const msg = session.messages[i];
    const next = session.messages[i + 1];

    if (msg.role === 'user' && next.role === 'assistant') {
        const responseTime = new Date(next.timestamp) - new Date(msg.timestamp);
        console.log(`Response time: ${responseTime}ms`);
    }
}
```

---

## Troubleshooting

### Logs Not Being Created
1. Check console for errors
2. Verify write permissions to app data directory
3. Ensure session is started (check status bar)

### Incomplete Logs
- JSON logs save every 5 messages - check if you had fewer messages
- If app crashes, some messages may be missing
- End session properly before quitting for complete logs

### Large Log Files
- Each session creates 2 files (text + JSON)
- Auto-cleanup removes files >30 days old
- Manual cleanup: Delete old files from `interview_logs/` folder

### Finding Log Files
1. Windows: Press `Win+R`, type `%AppData%\my-electron-app\interview_logs`
2. macOS: Open Finder, press `Cmd+Shift+G`, enter `~/Library/Application Support/my-electron-app/interview_logs`
3. Linux: Navigate to `~/.config/my-electron-app/interview_logs/`

---

## Best Practices

### Regular Review
- Review logs after each practice session
- Identify weak areas in your responses
- Track improvement over time

### Backup Important Sessions
- Copy log files to backup location
- Cloud storage for long-term retention
- Version control for tracking changes

### Redact Sensitive Info
- Remove any accidental credential mentions
- Sanitize company-specific information
- Use generic placeholders when sharing

### Organize by Interview
- Rename log files with interview company/date
- Create folders for different job applications
- Tag or categorize sessions in external tools

---

## FAQ

**Q: Can I disable session logging?**
A: Session logging is core to the app's functionality and cannot be disabled. However, you can delete log files manually at any time.

**Q: How much disk space do logs use?**
A: Approximately 50-200KB per session (varies with message count). A year of daily practice (~365 sessions) would use ~20-70MB.

**Q: Can I export logs to other formats?**
A: Yes! Parse the JSON logs with scripts to convert to CSV, PDF, or any format you need.

**Q: Are logs encrypted?**
A: No, logs are stored as plain text/JSON. Encrypt them manually if needed for sensitive content.

**Q: Can I recover a deleted session?**
A: No, deleted log files cannot be recovered unless you have a backup.

---

**Last Updated:** 2025-10-20
**Version:** 1.1.0
