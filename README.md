# WebRTC Collaborative Canvas

A real-time collaborative drawing application built with WebRTC, allowing multiple users to draw on a shared canvas simultaneously.

## Features

- 🎨 **Real-time Collaborative Drawing**: Multiple users can draw on the same canvas simultaneously
- 🌐 **WebRTC P2P Communication**: Direct peer-to-peer data transmission for low latency
- 📱 **Cross-platform Support**: Works on desktop and mobile devices
- 🎯 **Touch Support**: Full touch screen support for mobile devices
- 🎨 **Customizable Drawing Tools**: Color picker and brush size controls
- 🧹 **Clear Canvas**: Synchronized canvas clearing for all users
- 👥 **User Count Display**: Shows number of connected users
- 🔄 **Automatic Reconnection**: Handles connection drops gracefully
- 📡 **Fallback Communication**: Socket.io fallback for users without WebRTC support

## Technology Stack

- **Frontend**: HTML5 Canvas, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express.js
- **Real-time Communication**: Socket.io for signaling, WebRTC for data channels
- **Styling**: Modern CSS with gradients and animations

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd webrtc-canvas
```

2. Install dependencies:
```bash
npm install
```

3. Start the server:
```bash
npm start
```

4. Open your browser and navigate to `http://localhost:3000`

## Development

For development with auto-restart:
```bash
npm run dev
```

## How It Works

### WebRTC Implementation
1. **Signaling Server**: Socket.io server handles initial connection and WebRTC signaling
2. **Peer Discovery**: When users join, they exchange connection information
3. **Data Channels**: Direct P2P data channels are established for drawing data
4. **Fallback**: Socket.io serves as fallback for browsers without WebRTC support

### Drawing Synchronization
- Mouse/touch events are captured on the canvas
- Drawing data (coordinates, color, brush size) is packaged
- Data is transmitted via WebRTC data channels to all connected peers
- Remote drawing data is rendered on each user's canvas in real-time

### Connection Management
- Automatic user discovery when joining
- Graceful handling of user disconnections
- Real-time user count updates
- Connection status indicators

## Browser Compatibility

- **WebRTC Support**: Chrome, Firefox, Safari, Edge (modern versions)
- **Fallback**: All browsers with Socket.io support
- **Mobile**: iOS Safari, Chrome Mobile, Firefox Mobile

## Usage

1. Open the application in multiple browser tabs or different devices
2. Start drawing on the canvas with your mouse or finger
3. See real-time collaborative drawing from other users
4. Use color picker to change drawing color
5. Adjust brush size with the slider
6. Clear the canvas for all users with the "Clear Canvas" button

## Project Structure

```
webrtc-canvas/
├── public/
│   ├── index.html      # Main HTML file
│   ├── style.css       # Styling and animations
│   └── script.js       # Client-side WebRTC and canvas logic
├── server.js           # Express server with Socket.io
├── package.json        # Dependencies and scripts
└── README.md          # This file
```

## API Endpoints

- `GET /` - Main application page
- `GET /health` - Health check endpoint with server status

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with multiple browser instances
5. Submit a pull request

## License

MIT License - feel free to use this project for learning and development.

## Future Enhancements

- [ ] Drawing history and undo/redo functionality
- [ ] Multiple drawing tools (rectangle, circle, line)
- [ ] Text annotations
- [ ] Layer support
- [ ] Save/export canvas as image
- [ ] User authentication and private rooms
- [ ] Drawing permissions and moderation
- [ ] Canvas size customization
