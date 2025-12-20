#!/bin/bash

# Odd Job Todd - Quick Deploy Script
echo "🔧 Odd Job Todd - Deployment Script"
echo "=================================="

# Check if vercel is installed
if ! command -v vercel &> /dev/null; then
    echo "📦 Installing Vercel CLI..."
    npm install -g vercel
fi

# Check if environment variables file exists
if [ ! -f ".env.local" ]; then
    echo "❌ Error: .env.local file not found!"
    echo "Please create .env.local with your Firebase and Anthropic API keys."
    echo "See SETUP.md for instructions."
    exit 1
fi

echo "🚀 Starting deployment..."

# Deploy to Vercel
vercel --prod

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Update your Meta ads to point to the new URL"
echo "2. Test the chatbot and admin dashboard"
echo "3. Create your admin user in Firebase Auth"
echo ""
echo "Questions? Check SETUP.md or README.md"