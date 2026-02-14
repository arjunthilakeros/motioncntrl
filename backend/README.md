# Backend - EROS UNIVERSE

Backend server for Kling AI Motion Control integration.

## 🔐 Environment Setup

### 1. Configure Environment Variables

Copy the example file and add your credentials:

```bash
cp .env.example .env
```

Then edit `.env` with your actual Kling AI credentials.

### 2. Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `KLING_ACCESS_KEY` | Your Kling AI Access Key | ✅ Yes |
| `KLING_SECRET_KEY` | Your Kling AI Secret Key | ✅ Yes |
| `KLING_API_BASE_URL` | Base URL for Kling API | ✅ Yes |
| `KLING_API_VERSION` | API version (v1) | ✅ Yes |
| `PORT` | Server port | Optional (default: 3000) |
| `NODE_ENV` | Environment (development/production) | Optional |

### 3. Security Notes

⚠️ **IMPORTANT**:
- Never commit `.env` file to version control
- `.gitignore` is configured to exclude `.env`
- Share `.env.example` with team, not `.env`
- Rotate keys if accidentally exposed

## 🚀 Getting Started

```bash
# Install dependencies (after choosing your tech stack)
npm install  # or pip install -r requirements.txt

# Run development server
npm run dev  # or python app.py
```

## 📚 API Integration

The Kling AI credentials are used for:
- Motion Control video generation
- Authentication with Kling API
- Task creation and status polling
- Video result retrieval

Refer to: `C:\Users\Hp\.claude\projects\C--Users-Hp-Desktop-Kling\memory\kling-motion-control-api.md`
