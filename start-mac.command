#!/bin/bash
# Double-click this file to start the Sanford Homeschoolers Check-In/Out system.
# The first time you run it, it may take a minute while it sets everything up.

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js isn't installed yet."
  echo "Go to https://nodejs.org, download the LTS installer, run it, then double-click this file again."
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Setting up for the first time (this can take a minute)..."
  npm install
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created a .env settings file with default values."
  echo "You can open it in a text editor later to set a real admin password."
fi

echo ""
echo "Starting the Check-In/Out system..."
echo "Your browser will open automatically in a couple of seconds."
echo ""
echo "IMPORTANT: keep this window open while you're using the system."
echo "Closing it stops the server."
echo ""

( sleep 2 && open "http://localhost:3000" ) &

npm start
