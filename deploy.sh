#!/bin/bash

# Deploy Frontend to GitHub Pages

echo "🚀 Deploying Frontend to GitHub Pages"
echo "======================================"
echo ""

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "📦 Initializing git repository..."
    git init
    git branch -M main
fi

# Get repository URL
echo "Enter your GitHub repository URL (e.g., https://github.com/username/fastfood-empire.git):"
read REPO_URL

if [ -z "$REPO_URL" ]; then
    echo "❌ Repository URL is required!"
    exit 1
fi

# Add remote if not exists
if ! git remote | grep -q "origin"; then
    echo "🔗 Adding remote origin..."
    git remote add origin $REPO_URL
fi

# Stage all files
echo "📝 Staging files..."
git add .

# Commit
echo "💾 Committing changes..."
git commit -m "Deploy FastFood Empire WebApp"

# Push to GitHub
echo "☁️  Pushing to GitHub..."
git push -u origin main

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Go to your repository on GitHub"
echo "2. Settings → Pages"
echo "3. Source: main branch, / (root) folder"
echo "4. Save and wait for deployment"
echo "5. Your app will be available at: https://yourusername.github.io/fastfood-empire/"
echo ""
echo "Don't forget to update API_URL in app.js!"
