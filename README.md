# 💬 WhatsApp Webhook Gateway Tester & Real-Time Dashboard

A modern, lightweight developer testing gateway and interactive dashboard for Meta's WhatsApp Cloud API. It features **SQLite persistence**, real-time message streaming, and **auto-responder AI integrations** (Google Gemini & OpenRouter) with conversational memory.

---

## ✨ Features

- **⚡ Real-Time Payload Stream**: Built with Server-Sent Events (SSE) to display incoming Meta Webhook payloads instantly in the dashboard without manual page refreshes.
- **🗄️ SQLite Database Engine**: High-performance local storage using `better-sqlite3` to store incoming and outgoing messages. It automatically migrates legacy JSON databases on startup.
- **🧠 10-Message Chat Memory**: Keeps context-aware conversations by feeding the last 9 messages + the new message to AI models for natural multi-turn chat sessions.
- **🖼️ Image Only Mode**: Toggleable from the header. When active, text messages are skipped and only images are processed (ideal for food/nutrition image analysis).
- **🤖 Dual AI Integrations**: Supported natively for **Google Gemini API** (`gemini-2.0-flash-lite` etc.) and **OpenRouter API** (`llama-3` etc.).
- **🔐 PIN-Protected Console**: PIN-based authentication to lock access to the dashboard.
- **📥 Media Downloader**: Automatically downloads and saves images, audio, and video messages locally to bypass WhatsApp's 10-minute temporary URL expirations.
- **☁️ Cloudflare Tunnel Setup**: Built-in support to run a global tunnel (`cloudflared`) on startup, routing Meta webhook deliveries to `localhost` instantly.

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3), `dotenv`, `cors`.
- **Frontend**: Responsive CSS grid, custom theme (Dark Mode with glassmorphism effects), Vanilla JS, [Lucide Icons](https://lucide.dev/).
- **AI Services**: Google Generative Language API, OpenRouter API.

---

## 🚀 Getting Started

### 1. Prerequisites
- Node.js (v18 or higher recommended)
- Meta WhatsApp Business Account Developer Credentials (for live testing)
- `cloudflared` installed (optional, for webhook tunneling)

### 2. Installation
Clone the repository and install the dependencies:
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root folder (or copy from `.env.example`):
```env
PORT=3000
WEBHOOK_PATH=/webhook
PIN=1122

# Cloudflare Tunnel Configuration
CF_TUNNEL=FALSE
CF_TUNNEL_TOKEN=your_token_here

# Meta WhatsApp Cloud API credentials (for sending live replies)
WA_ACCESS_TOKEN=your_token_here
WA_PHONE_NUMBER_ID=your_phone_id_here
```

### 4. Running the Application
Start the gateway in development hot-reload mode:
```bash
npm run dev
```
Or in production mode:
```bash
npm start
```
Open your browser at `http://localhost:3000` to access the dashboard.

---

## 📂 Project Structure

```
├── data/
│   └── database.sqlite    # SQLite database file (initialized on startup)
├── public/
│   ├── css/               # Styling for dashboard and AI tester
│   ├── js/                # SSE consumer and interactive controllers
│   ├── index.html         # Main real-time webhook dashboard console
│   ├── ai-tester.html     # AI Playground & Prompts config tester
│   └── login.html         # Auth login page
├── src/
│   ├── db.js              # SQLite initialization, migrations & CRUD handlers
│   └── server.js          # REST endpoints, SSE stream, and AI responder logic
├── .env.example
├── package.json
└── README.md
```

---

## 🔒 License
This project is licensed under the ISC License.
