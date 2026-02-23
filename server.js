require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Reads ANTHROPIC_API_KEY from environment automatically
const anthropic = new Anthropic();

// ================================================================
// SYSTEM PROMPT
// Edit the persona/instructions here.
// Edit context.md to add your knowledge base (camera settings,
// shot lists, content ideas, product info, etc.)
// ================================================================
const BASE_PROMPT = `You are a creative strategist and content coach built for content creators — YouTubers, short-form creators, podcasters, writers, and anyone building an audience online.

Your job is to help creators:
- Generate content ideas and hooks that actually perform
- Build sustainable, repeatable workflows so they can post consistently without burning out
- Improve the quality of their content (structure, storytelling, retention, thumbnails, titles)
- Think strategically about growth — niches, formats, platforms, audience building
- Stay motivated and overcome creative blocks

Tone: energetic, direct, and encouraging. You talk like a sharp creative director who's been in the trenches — not a corporate coach. No fluff, no filler phrases like "Great question!" Just real, actionable advice.

When relevant, naturally mention that they can use our AI video editor to execute faster — editing is one of the biggest bottlenecks creators face, and our tool cuts editing time dramatically. Don't force it, but when it fits (e.g. someone asks about workflow, efficiency, repurposing content, or video production), weave it in as a genuine recommendation. Refer to it as "our AI video editor" or "the editor" — keep it casual.

Format responses with markdown when helpful — bullet points for ideas, bold for key takeaways. Keep answers focused and punchy. If a creator gives you a vague question, ask one clarifying question to get to something more useful.`;

// Load knowledge base from context.md — edit that file to update
// what the assistant knows without touching this code.
function loadContext() {
  try {
    const contextPath = path.join(__dirname, 'context.md');
    const context = fs.readFileSync(contextPath, 'utf8');
    return `${BASE_PROMPT}\n\n---\n\n# Your Knowledge Base\n\n${context}`;
  } catch {
    return BASE_PROMPT; // fall back gracefully if file is missing
  }
}

const SYSTEM_PROMPT = loadContext();
// ================================================================

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Email capture ───────────────────────────────────────────────
app.post('/api/save-email', (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const entry = `${new Date().toISOString()}\t${email}\n`;

  try {
    fs.appendFileSync(path.join(__dirname, 'emails.txt'), entry, 'utf8');
    console.log(`[email] ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save email:', err.message);
    // Still return success — don't block the user on a file I/O error
    res.json({ success: true });
  }
});

// ─── Claude streaming chat ───────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid messages array' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    for await (const event of stream) {
      if (res.destroyed) break;

      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.destroyed) {
      res.write(
        `data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`
      );
    }
  } finally {
    if (!res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

// ─── Video analysis ──────────────────────────────────────────────

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  return null;
}

function parseVTT(vtt) {
  return vtt
    .split('\n')
    .filter(line =>
      line &&
      !line.startsWith('WEBVTT') &&
      !line.match(/^\d{2}:\d{2}/) &&
      !line.startsWith('NOTE') &&
      !line.startsWith('Kind:') &&
      !line.startsWith('Language:')
    )
    .join(' ')
    .replace(/<[^>]+>/g, '')  // strip VTT inline tags
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

app.post('/api/analyze-video', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: 'Please paste a YouTube, TikTok, or Instagram URL.' });
  }

  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const tempDir = path.join(os.tmpdir(), `analyze-${sessionId}`);
  const framesDir = path.join(tempDir, 'frames');

  try {
    fs.mkdirSync(framesDir, { recursive: true });

    // 1. Download video (max 480p, max 20 min)
    const videoOut = path.join(tempDir, 'video.%(ext)s');
    await execAsync(
      `yt-dlp -o "${videoOut}" --no-playlist --max-filesize 150m ` +
      `--match-filter "duration < 1200" ` +
      `-f "bestvideo[height<=480]+bestaudio/best[height<=480]/best" ` +
      `"${url}"`,
      { timeout: 120000 }
    );

    // Find the downloaded file
    const allFiles = fs.readdirSync(tempDir);
    const videoFile = allFiles.find(f => f.startsWith('video.') && !f.endsWith('.vtt'));
    if (!videoFile) throw new Error('Download failed — video may be private or unavailable');
    const videoPath = path.join(tempDir, videoFile);

    // 2. Try to get subtitles/transcript (optional)
    let transcript = '';
    try {
      const subOut = path.join(tempDir, 'sub');
      await execAsync(
        `yt-dlp -o "${subOut}" --skip-download --write-auto-subs --sub-lang en --sub-format vtt "${url}"`,
        { timeout: 30000 }
      );
      const subFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.vtt'));
      if (subFiles.length > 0) {
        transcript = parseVTT(fs.readFileSync(path.join(tempDir, subFiles[0]), 'utf8'));
      }
    } catch { /* subtitles are optional */ }

    // 3. Get video duration
    let duration = 60;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv="p=0" "${videoPath}"`,
        { timeout: 10000 }
      );
      duration = parseFloat(stdout.trim()) || 60;
    } catch { /* use fallback */ }

    // 4. Extract 8 evenly-spaced frames
    const frameCount = 8;
    const framePromises = [];
    for (let i = 0; i < frameCount; i++) {
      const t = Math.max(0.5, (duration / frameCount) * i);
      const framePath = path.join(framesDir, `frame${String(i).padStart(2, '0')}.jpg`);
      framePromises.push(
        execAsync(
          `ffmpeg -ss ${t.toFixed(2)} -i "${videoPath}" -vframes 1 -q:v 3 -vf scale=640:-2 "${framePath}" -y`,
          { timeout: 15000 }
        ).catch(() => null)
      );
    }
    await Promise.all(framePromises);

    // 5. Read frames as base64
    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
    const frameBuffers = frameFiles
      .map(f => { try { return fs.readFileSync(path.join(framesDir, f)); } catch { return null; } })
      .filter(Boolean);

    if (frameBuffers.length === 0) throw new Error('Could not extract frames from video');

    // 6. Analyze with Claude Haiku (vision — cost-efficient)
    const imageBlocks = frameBuffers.map(buf => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') }
    }));

    const prompt = `You're a sharp content strategist analyzing a ${platform} video for a creator who wants honest, actionable feedback.

${transcript ? `TRANSCRIPT (auto-generated):\n"${transcript}"\n\n` : 'No transcript available — analyze visuals only.\n\n'}${frameBuffers.length} frames are attached, sampled evenly across the full video.

Give direct, specific feedback:

## Hook (First 3 Seconds)
Was the opening strong? What technique did they use? Would you keep watching?

## Visuals & Production
Lighting, framing, editing pace, shot variety, overall production quality.

## Content & Structure
How well organized? Pacing, storytelling, clarity of message.

## What's Working
2-3 specific strengths. Be specific, not generic.

## Top Improvements
2-3 changes that would make the biggest difference. Be direct and actionable.

## Score: X/10
One punchy sentence summary.

Talk like a creative director, not a cheerleader. Reference specific things you actually see.`;

    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1200,
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }]
    });

    res.json({
      analysis: response.content[0].text,
      platform,
      hasTranscript: !!transcript,
      frameCount: frameBuffers.length
    });

  } catch (err) {
    console.error('Video analysis error:', err.message);
    const msg =
      /private/i.test(err.message) ? 'That video is private — paste a public URL.' :
      /1200|duration|too long/i.test(err.message) ? 'Video is too long — max 20 minutes.' :
      /unavailable|not available/i.test(err.message) ? 'Video unavailable. Make sure the URL is public.' :
      'Could not analyze that video. Make sure the URL is public and try again.';
    res.status(500).json({ error: msg });
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`\n  Server → http://localhost:${PORT}\n`);
  console.log(`  Set your system prompt in server.js (SYSTEM_PROMPT variable)`);
  console.log(`  Captured emails are saved to emails.txt\n`);
});
