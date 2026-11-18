# WhatsApp AI Agent (Render)

Node.js webhook for WhatsApp Cloud API. Incoming text messages are sent to OpenAI and the generated reply is sent back through WhatsApp Cloud API. Replies mirror the customer's language (English or Kiswahili).

## Endpoints

- `GET /health` - health/configuration check
- `GET /webhook` - Meta webhook verification handshake
- `POST /webhook` - signed WhatsApp webhook events

## Deploy on Render

1. Create a GitHub repository (private is recommended) and upload these files, preserving the `src/server.js` path.
2. In Render, choose **New + > Web Service**, connect the GitHub repository, and set:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
3. Add the environment variables listed below in Render's Environment page. Do not commit `.env` or secrets to GitHub.
4. Deploy. Render will provide a URL such as `https://your-service-name.onrender.com`.
5. Set Meta's webhook callback URL to `https://your-service-name.onrender.com/webhook` and enter the exact same `WEBHOOK_VERIFY_TOKEN` value. Subscribe the WhatsApp `messages` field.

## Required Render environment variables

- `META_APP_SECRET` - Meta App Secret (App settings > Basic)
- `WEBHOOK_VERIFY_TOKEN` - long random secret you create; use the same value in Meta webhook setup
- `WHATSAPP_ACCESS_TOKEN` - WhatsApp Cloud API access token
- `WHATSAPP_PHONE_NUMBER_ID` - Phone Number ID, not the visible phone number
- `META_GRAPH_API_VERSION` - Graph API version supported/shown for your Meta app
- `OPENAI_API_KEY` - OpenAI API key
- `OPENAI_MODEL` - optional; defaults to `gpt-4.1-mini`

## Important notes

- This server handles text, button, and interactive reply messages. Media and voice transcription are not implemented yet.
- The current duplicate-event cache is in memory. It protects against immediate webhook retries on one running instance but is cleared on restart and is not shared across multiple instances. Use Redis or a database for durable production deduplication.
- Configure WhatsApp Coexistence if you need to keep using the same number in the WhatsApp Business mobile app. Confirm eligibility in Meta's onboarding before migrating or changing the number.
- The assistant has no business-specific FAQ, product catalogue, pricing, or policy data yet. Add approved business information before relying on it for customer commitments.
- Meta may require an approved/active business setup, appropriate permissions, and a suitable access token for production messaging. Follow Meta's WhatsApp policies and customer opt-in requirements.
