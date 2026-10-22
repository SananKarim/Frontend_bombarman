/* Frontend configuration — plain JS so campaign mode also works from file://.
   SERVER_URL: the authoritative Node.js + Socket.IO game server.
   - Local separate ports: leave empty. A page at http://HOST:5000 automatically
     connects to http://HOST:3000, including phones using the computer's LAN IP.
   - Local single port: leave empty and start with SERVE_PUBLIC=1.
   - Production: set the full Cloud Run URL (no trailing slash).
   Firebase Hosting does not proxy WebSockets to Cloud Run. */
window.MULTIPLAYER_CONFIG = {
  SERVER_URL: '',
  ROOM_LIMIT_MAX: 8,
  SYNC_HZ: 10,
};
