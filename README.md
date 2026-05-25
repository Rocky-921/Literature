# Literature Card Game

## Setup (one-time)
```bash
npm install
```

## Run
```bash
node server.js
```

Server starts at `http://0.0.0.0:3000`

## Play
1. One player opens `http://<your-ip>:3000` and creates a room
2. Share the 4-letter room code with 5 friends on same WiFi
3. They visit the same URL and join with the code
4. All 6 players pick seats (seats 1,3,5 = Team A; seats 2,4,6 = Team B)
5. Anyone clicks "Start Game"

## How to find your IP (to share with friends)
- **Linux/Mac**: `ip addr show` or `ifconfig`
- **Windows**: `ipconfig`
- Look for something like `10.x.x.x` or `192.168.x.x` on IITM wifi

## Game Rules Summary
- 8s removed from deck, 48 cards dealt 8 each to 6 players
- Ask opponents for cards you need (must have one card of same half-suit)
- If they have it → you get it, your turn continues
- If they don't → their turn starts
- Declare a book by correctly guessing which teammate has which card
- Wrong distribution → book forfeited; opponent has any card → opponent gets it
- Most books (out of 8) wins!
# Literature
