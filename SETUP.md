# Odd Job Todd - Setup Guide

## Quick Start (30 minutes to get live)

### 1. Firebase Setup (10 minutes)

1. **Create Firebase Project**
   - Go to [Firebase Console](https://console.firebase.google.com)
   - Click "Create a project"
   - Name it "oddjobtodd" (or your preferred name)
   - Disable Google Analytics (not needed)

2. **Enable Authentication**
   - Go to Authentication > Get started
   - Sign-in method tab
   - Enable "Email/Password"
   - Add your admin user:
     - Go to Users tab > Add user
     - Email: todd@oddjobtodd.com.au (or your email)
     - Password: (create a strong password)

3. **Create Firestore Database**
   - Go to Firestore Database > Create database
   - Start in production mode
   - Choose location closest to Australia (asia-southeast1 recommended)

4. **Enable Firebase Storage**
   - Go to Storage > Get started
   - Start in production mode
   - Use same location as Firestore

5. **Get Firebase Config**
   - Go to Project settings (gear icon)
   - Your apps > Add app > Web app
   - Name it "Odd Job Todd"
   - Copy the config object (you'll need this for environment variables)

### 2. Environment Variables (5 minutes)

Update your `.env.local` file with your Firebase config:

```bash
# Firebase Configuration (from step 5 above)
NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key-here
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id

# Anthropic API Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key-here

# Admin Configuration
ADMIN_EMAIL=todd@oddjobtodd.com.au
```

### 3. Get Your Anthropic API Key (2 minutes)

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Sign up/sign in
3. Go to API Keys > Create Key
4. Copy the key and add it to your `.env.local`

### 4. Test Locally (5 minutes)

```bash
npm run dev
```

- Open http://localhost:3000 - Customer chatbot should load
- Open http://localhost:3000/admin - Admin login should work
- Test the chatbot flow
- Login to admin dashboard

### 5. Deploy to Vercel (8 minutes)

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Deploy**
   ```bash
   vercel
   ```

   Follow the prompts:
   - Link to existing project? No
   - Project name: odd-job-todd
   - Directory: ./ (current directory)
   - Auto-deploy? Yes

3. **Add Environment Variables**
   ```bash
   vercel env add ANTHROPIC_API_KEY
   vercel env add NEXT_PUBLIC_FIREBASE_API_KEY
   vercel env add NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
   vercel env add NEXT_PUBLIC_FIREBASE_PROJECT_ID
   vercel env add NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
   vercel env add NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
   vercel env add NEXT_PUBLIC_FIREBASE_APP_ID
   vercel env add ADMIN_EMAIL
   ```

   Paste each value when prompted. Choose "Production" for all.

4. **Redeploy with Environment Variables**
   ```bash
   vercel --prod
   ```

## Your App is Live! 🎉

- **Customer Chatbot**: https://your-app.vercel.app
- **Admin Dashboard**: https://your-app.vercel.app/admin

## Next Steps

### Update Your Meta Ads

Change your Meta ad button to point to your new URL:
- Button text: "Get Instant Quote"
- URL: https://your-app.vercel.app

### Add Your Domain (Optional)

1. Buy a domain (e.g., oddjobtodd.com.au)
2. In Vercel dashboard: Settings > Domains
3. Add your domain and follow DNS instructions

### Firebase Security Rules

Update Firestore security rules for production:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Jobs can be read by anyone, written by authenticated users
    match /jobs/{jobId} {
      allow read: if true;
      allow write: if request.auth != null;
    }

    // Flat rate jobs read-only for everyone
    match /flatRateJobs/{jobId} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == 'todd@oddjobtodd.com.au';
    }
  }
}
```

Update Storage security rules:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /jobs/{jobId}/{allPaths=**} {
      allow read: if true;
      allow write: if true;
    }
  }
}
```

## Troubleshooting

### Common Issues

1. **"Firebase config not found"**
   - Check your environment variables are correct
   - Redeploy after adding env vars

2. **"Authentication failed"**
   - Ensure you created the admin user in Firebase Auth
   - Check the email matches your ADMIN_EMAIL env var

3. **"Photos won't upload"**
   - Check Firebase Storage is enabled
   - Verify storage security rules

4. **"Chatbot not responding"**
   - Check Anthropic API key is valid
   - Check browser console for errors

### Support

- Check Firebase logs for backend issues
- Check Vercel function logs for API issues
- Test locally first with `npm run dev`

## Cost Estimate

**Monthly costs for first 1000+ leads:**

- Vercel: $0 (free tier)
- Firebase: $0 (free tier - 50k reads, 20k writes, 5GB storage)
- Anthropic API: ~$20-50 (depends on conversation length)

**Total: $20-50/month**

This scales automatically - you'll only pay more when you're doing serious volume.

## Success Metrics to Track

1. **Chatbot completion rate** (people who finish the conversation)
2. **Lead quality improvement** (compared to old Meta leads)
3. **Time saved per lead** (less back-and-forth)
4. **Conversion rate** (leads that become jobs)

Track these in your admin dashboard to validate the ROI.