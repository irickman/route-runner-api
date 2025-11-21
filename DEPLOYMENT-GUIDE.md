# Deployment Guide - Cloudflare Workers

## Quick Deploy

```bash
npm run deploy
```

## Pre-Deployment Checklist

### 1. ✅ Code is Ready
- [x] All changes committed
- [x] Branch pushed to GitHub
- [x] Code tested locally

### 2. 🔐 Secrets Configured
Make sure production secrets are set:
```bash
# Check if secrets are set
npx wrangler secret list

# If missing, set them:
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MAPBOX_TOKEN
```

### 3. 🌿 Branch Selection
Deploy from the branch you want in production:
- `main` or `master` - Production branch
- `fix-gpx-and-improve-routing` - Feature branch (if deploying feature)

## Deployment Steps

### Option 1: Deploy from Current Branch
```bash
# Make sure you're on the branch you want to deploy
git checkout main  # or your production branch

# Merge your feature branch if needed
git merge fix-gpx-and-improve-routing

# Deploy
npm run deploy
```

### Option 2: Deploy Feature Branch Directly
```bash
# Stay on feature branch
git checkout fix-gpx-and-improve-routing

# Deploy (will deploy this branch's code)
npm run deploy
```

## Post-Deployment

### 1. Verify Deployment
```bash
# Test production API
npm run test-production

# Or manually test
curl -X POST https://route-runner-api.route-runner.workers.dev/api/generate-route \
  -H "Content-Type: application/json" \
  -d '{"query": "5 mile loop", "location": {"lat": 47.6107, "lng": -122.3356}}'
```

### 2. Monitor Logs
```bash
# Watch production logs in real-time
npx wrangler tail

# Watch with filters
npx wrangler tail --format pretty
```

### 3. Check Performance
Look for the new performance metrics in logs:
```
⏱️  Performance: {
  "locationResolution": XXX,
  "routePlanning": XXX,
  ...
}
```

## Troubleshooting

### Deployment Fails
1. Check authentication: `npx wrangler whoami`
2. Verify secrets: `npx wrangler secret list`
3. Check build errors: `npx tsc --noEmit`

### API Not Working After Deploy
1. Check logs: `npx wrangler tail`
2. Verify secrets are set correctly
3. Test endpoint manually

### Performance Issues
1. Check logs for timing breakdown
2. Verify caching is working (KV namespace)
3. Monitor Cloudflare dashboard for errors

## Production URL

After deployment, your API will be available at:
```
https://route-runner-api.route-runner.workers.dev
```

## Rollback

If you need to rollback:
```bash
# Deploy previous version
git checkout <previous-commit>
npm run deploy

# Or deploy from main branch
git checkout main
npm run deploy
```

