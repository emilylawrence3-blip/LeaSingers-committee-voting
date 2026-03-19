# Lea Singers Committee Voting

A simple, mobile-friendly web app for anonymous committee voting.

## Pages

| Page | URL | Purpose |
|------|-----|---------|
| **Vote** | `/` | Members visit this page to cast their vote |
| **Admin** | `/admin` | Add/remove nominees, open/close voting |
| **Results** | `/results` | View vote counts with a bar chart |

## Quick Start (Local)

```bash
npm install
npm start
```

Then open http://localhost:3000

## Admin Password

The default admin password is: `LeaSingers2026`

Change it by setting the environment variable `ADMIN_PASSWORD` before starting:

```bash
ADMIN_PASSWORD=YourNewPassword npm start
```

## Deploy to Render (Free Hosting)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) and sign up
3. Click **New > Web Service**
4. Connect your GitHub repo
5. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
6. Add environment variable: `ADMIN_PASSWORD` = your chosen password
7. Click **Deploy**

You'll get a public URL like `https://lea-singers-voting.onrender.com` to share with your choir.

## How It Works

1. **Admin** logs into `/admin` and adds nominee names
2. **Admin** ensures voting is open (toggle switch)
3. **Share** the main URL with choir members
4. **Members** select their choices and submit (one vote per device)
5. **View** results at `/results` — a bar chart shows vote totals
6. **Admin** can close voting when done
