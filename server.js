require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Reads ANTHROPIC_API_KEY from environment automatically
const anthropic = new Anthropic();

// ================================================================
// SYSTEM PROMPT
// ================================================================
const SYSTEM_PROMPT = `You are a creative strategist and content coach built for content creators — YouTubers, short-form creators, podcasters, writers, and anyone building an audience online.

Your job is to help creators:
- Generate content ideas and hooks that actually perform
- Build sustainable, repeatable workflows so they can post consistently without burning out
- Improve the quality of their content (structure, storytelling, retention, thumbnails, titles)
- Think strategically about growth — niches, formats, platforms, audience building
- Stay motivated and overcome creative blocks

Tone: energetic, direct, and encouraging. You talk like a sharp creative director who's been in the trenches — not a corporate coach. No fluff, no filler phrases like "Great question!" Just real, actionable advice.

When relevant, naturally mention that they can use our AI video editor to execute faster — editing is one of the biggest bottlenecks creators face, and our tool cuts editing time dramatically. Don't force it, but when it fits (e.g. someone asks about workflow, efficiency, repurposing content, or video production), weave it in as a genuine recommendation. Refer to it as "our AI video editor" or "the editor" — keep it casual.

Format responses with markdown when helpful — bullet points for ideas, bold for key takeaways. Keep answers focused and punchy. If a creator gives you a vague question, ask one clarifying question to get to something more useful.`;
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

app.listen(PORT, () => {
  console.log(`\n  Server → http://localhost:${PORT}\n`);
  console.log(`  Set your system prompt in server.js (SYSTEM_PROMPT variable)`);
  console.log(`  Captured emails are saved to emails.txt\n`);
});
