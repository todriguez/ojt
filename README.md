# 🔧 Odd Job Todd - AI Gatekeeper for Handyman Leads

A polite but firm AI assistant that forces customers to think and provide context before reaching you.

## What This Does

### For Your Customers
- **Professional conversation** with Todd's AI assistant
- **Smart photo guidance** ("step back, I need to see the whole area")
- **Context gathering** about the problem, materials, access
- **Reality check** - helps them understand if they need proper repair vs quick fix

### For You (Todd)
- **Only serious leads** reach you
- **Complete job sheets** with proper context
- **Decide quickly** - quote, inspect, decline, or defer
- **Save mental energy** - no more vague "fix window sill" messages

## The Core Problem This Solves

**Before:** Meta customers send lazy messages: "how much to fix window sill?" + blurry photo
**After:** Only customers who complete proper job descriptions reach you

This is not about quoting or pricing - it's about **qualification and context**.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up Firebase & environment variables (see SETUP.md)
# 3. Test locally
npm run dev

# 4. Deploy to Vercel
vercel --prod
```

**Total setup time: 30 minutes**

See [SETUP.md](./SETUP.md) for detailed instructions.

## Key Features

### 🤖 AI Qualification Assistant
- Forces customers to describe problems clearly
- Gathers material type, access info, urgency
- Filters out time-wasters who won't provide context

### 📱 Simple Review Dashboard
- View qualified job sheets with all details
- Quick decision buttons: Will Quote / Need Inspection / Decline
- One-click email/SMS contact with job details
- Filter: Needs Review / Reviewed / Declined

### 📸 Smart Photo Collection
- Forces customers to take useful photos (wide shot + close-up)
- "Step back 2 meters, I need to see the whole area"
- Automatic Firebase storage

### ⚡ Cognitive Load Relief
- No more evenings spent deciphering vague messages
- No guilt from ignored enquiries
- Only serious customers make it through

### 🔒 Security
- Admin-only dashboard access
- Firebase authentication
- Secure file uploads

## Tech Stack

- **Frontend**: Next.js 14, TypeScript, Tailwind CSS
- **Backend**: Firebase (Firestore + Storage + Auth)
- **AI**: Anthropic Claude API
- **Hosting**: Vercel (free tier)
- **Cost**: ~$20-50/month for 1000+ leads

## File Structure

```
src/
├── app/
│   ├── api/
│   │   ├── chat/          # Claude API integration
│   │   └── upload/        # Photo upload endpoint
│   ├── admin/             # Admin dashboard page
│   └── page.tsx           # Customer chatbot
├── components/
│   ├── CustomerChatbot.tsx
│   ├── AdminDashboard.tsx
│   └── AdminLogin.tsx
├── lib/
│   ├── firebase.ts        # Firebase config
│   ├── jobService.ts      # Database operations
│   ├── authService.ts     # Authentication
│   └── flatRateJobs.ts    # Pricing configuration
├── types/
│   └── job.ts            # TypeScript interfaces
└── hooks/
    └── usePhotoUpload.ts  # Photo upload logic
```

## Environment Variables

```bash
# Firebase
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Anthropic
ANTHROPIC_API_KEY=

# Admin
ADMIN_EMAIL=todd@oddjobtodd.com.au
```

## Usage

### Customer Flow
1. Customer clicks Meta ad → lands on AI assistant
2. AI says: *"Help me understand your job so Todd can tell you if he can help"*
3. AI gathers: problem description, photos (wide + close-up), materials, access
4. Only customers who provide proper context complete the flow
5. Job sheet created for Todd to review

### Todd's Flow
1. Login to `/admin` → see "Needs Review" jobs
2. Review job sheet with all context & photos
3. Quick decision: **Will Quote** / **Need Inspection** / **Decline**
4. Email customer directly if interested
5. No time wasted on incomplete enquiries

## Customization

### Modify AI Questions
Edit system prompt in `src/app/api/chat/route.ts` to adjust what questions the AI asks

### Update Branding
- Colors in `tailwind.config.js`
- Logo/name in components
- Header messaging in `CustomerChatbot.tsx`

### Add Decision Options
Edit `AdminDashboard.tsx` to add more decision buttons beyond Will Quote/Need Inspection/Decline

## Deployment

### Vercel (Recommended)
```bash
vercel --prod
```

### Other Platforms
- **Netlify**: Needs serverless functions setup
- **Railway**: Works out of the box
- **VPS**: Requires Docker configuration

## Monitoring

### Key Metrics
- Chatbot completion rate
- Lead qualification improvement
- Time saved per lead
- Revenue per qualified lead

### Logs
- Vercel function logs for API issues
- Firebase console for database/storage
- Browser console for frontend issues

## Results You Can Expect

### Week 1: Immediate Impact
- 80%+ reduction in vague "how much?" messages
- Only customers who complete 5-minute conversation reach you
- Clear context for every enquiry

### Month 1: Workflow Change
- Evenings freed up from deciphering messages
- No guilt from ignored incomplete enquiries
- Faster decision-making with complete information

### Long Term: Business Growth
- Higher conversion rates on qualified leads
- Professional image with serious customers
- Scalable lead processing without hiring staff

## Support

1. Check [SETUP.md](./SETUP.md) for detailed setup
2. Review logs in Vercel/Firebase consoles
3. Test locally with `npm run dev`

Built for **Odd Job Todd** - your AI gatekeeper that saves mental energy and filters serious customers.

---

*Ready to eliminate vague enquiries forever? See SETUP.md to get started.*