
'use strict';

const crypto = require('node:crypto');
const express = require('express');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v27.0';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const requiredVariables = {
  WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  META_APP_SECRET: APP_SECRET,
  WHATSAPP_ACCESS_TOKEN: WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
  OPENAI_API_KEY
};

const missingVariables = Object.entries(requiredVariables)
  .filter(([, value]) => !value)
  .map(([name]) => name);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: missingVariables.length ? 'needs_configuration' : 'ok',
    service: 'whatsapp-ai-agent',
    missingEnvironmentVariables: missingVariables
  });
});

// Meta webhook verification
app.get('/webhook', (req, res) => {
  console.log('META WEBHOOK VERIFICATION REQUEST RECEIVED');

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('META WEBHOOK VERIFICATION SUCCESSFUL');
    return res.status(200).send(challenge);
  }

  console.log('META WEBHOOK VERIFICATION FAILED');
  return res.sendStatus(403);
});

// Extract text from different WhatsApp message types
function extractMessageText(message) {
  if (message.text?.body) {
    return message.text.body;
  }

  if (message.button?.text) {
    return message.button.text;
  }

  if (message.interactive?.button_reply?.title) {
    return message.interactive.button_reply.title;
  }

  if (message.interactive?.list_reply?.title) {
    return message.interactive.list_reply.title;
  }

  return '';
}

// Verify Meta request signature
function verifySignature(rawBody, signature) {
  if (!APP_SECRET || !signature || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', APP_SECRET)
      .update(rawBody)
      .digest('hex');

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

// Generate AI reply
async function generateAIReply(userMessage) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY is missing');
  }

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    instructions:
      'You are a helpful WhatsApp customer support assistant. ' +
      'Reply clearly, politely and naturally. Keep answers concise.',
    input: userMessage
  });

  return response.output_text ||
    'Sorry, I could not generate a response. Please try again.';
}

// Send WhatsApp reply
async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('WhatsApp environment variables are missing');
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/` +
    `${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: message
      }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error('WHATSAPP API ERROR:', response.status, result);
    throw new Error(`WhatsApp API returned HTTP ${response.status}`);
  }

  console.log('WHATSAPP MESSAGE SENT SUCCESSFULLY');
  console.log('WhatsApp message ID:', result.messages?.[0]?.id);

  return result;
}

// Process incoming WhatsApp messages
async function processWebhook(payload) {
  try {
    console.log('PROCESSING WEBHOOK PAYLOAD');

    if (payload.object !== 'whatsapp_business_account') {
      console.log('Ignoring non-WhatsApp webhook object');
      return;
    }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') {
          console.log('Ignoring webhook field:', change.field);
          continue;
        }

        const messages = change.value?.messages || [];

        console.log('Incoming message count:', messages.length);

        for (const message of messages) {
          // Ignore messages sent by the business itself
          if (message.from === undefined) {
            continue;
          }

          const sender = message.from;
          const userMessage = extractMessageText(message);

          console.log('Incoming WhatsApp message received');
          console.log('Message type:', message.type);

          if (!userMessage.trim()) {
            console.log('Message has no supported text content');
            continue;
          }

          console.log('Generating AI response');

          const aiReply = await generateAIReply(userMessage);

          console.log('AI response generated');

          await sendWhatsAppMessage(sender, aiReply);
        }
      }
    }
  } catch (error) {
    console.error('WEBHOOK PROCESSING ERROR:', error);
  }
}

// Receive Meta webhook notifications
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    console.log('======================================');
    console.log('META WEBHOOK POST RECEIVED');
    console.log('Time:', new Date().toISOString());
    console.log('Signature header present:',
      Boolean(req.headers['x-hub-signature-256']));
    console.log('======================================');

    if (!Buffer.isBuffer(req.body)) {
      console.error('Webhook body is not a raw Buffer');
      return res.sendStatus(400);
    }

    const signature = req.headers['x-hub-signature-256'];

    if (!verifySignature(req.body, signature)) {
      console.error('META SIGNATURE VERIFICATION FAILED');
      return res.sendStatus(401);
    }

    console.log('META SIGNATURE VERIFIED');

    let payload;

    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (error) {
      console.error('INVALID WEBHOOK JSON:', error.message);
      return res.sendStatus(400);
    }

    console.log('Webhook object:', payload.object);

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        console.log('Webhook field:', change.field);
      }
    }

    // Acknowledge Meta immediately, then process in the background
    res.sendStatus(200);

    processWebhook(payload).catch(error => {
      console.error('BACKGROUND WEBHOOK ERROR:', error);
    });
  }
);

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).send('WhatsApp AI Agent is running.');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('======================================');
  console.log(`WhatsApp AI webhook listening on port ${PORT}`);
  console.log('Webhook endpoint: /webhook');
  console.log('Health endpoint: /health');

  if (missingVariables.length) {
    console.error(
      'MISSING ENVIRONMENT VARIABLES:',
      missingVariables.join(', ')
    );
  } else {
    console.log('Required environment variables are present.');
  }

  console.log('======================================');
});
