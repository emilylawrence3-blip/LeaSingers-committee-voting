# Lea Singers Committee Voting

A simple, mobile-friendly web app for anonymous committee voting. Voting happens in order by position (Chair, Treasurer, Secretary, Other Committee Members) — once someone is elected to a position, they're automatically excluded from later votes.

## Pages

| Page | URL | Purpose |
|------|-----|---------|
| **Vote** | `/` | Members vote one position at a time, questionnaire-style |
| **Admin** | `/admin` | Manage positions, nominees, declare winners, open/close voting |
| **Results** | `/results` | View vote counts per position with bar charts |

## How It Works

1. **Admin** logs into `/admin` and adds nominees against each position (Chair, Treasurer, Secretary, Other Committee Members)
2. **Admin** opens voting (toggle switch) and optionally makes results public
3. **Share** the main URL with choir members
4. **Members** see one position at a time on their phone. They select a nominee (or "No vote") and tap Next to move to the next position
5. Once a position's voting is done, **Admin** declares the winner — that person is automatically removed from all remaining positions
6. **View** results at `/results` — each position has its own bar chart
7. **Admin** can close voting when done

## Positions (Pre-configured)

- **Chair** (1 winner)
- **Treasurer** (1 winner)
- **Secretary** (1 winner)
- **Other Committee Member** (up to 4 winners)

You can add/remove positions from the admin panel.

## Quick Start (Local)

```bash
npm install
npm start
```

Then open http://localhost:3000

## Admin Password

Default: `LeaSingers2026`

Change it by setting the environment variable `ADMIN_PASSWORD`.

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

## Anonymous Voting

- Each voter gets a unique anonymous token via a browser cookie
- No names, emails or logins are collected
- One vote per device per position
