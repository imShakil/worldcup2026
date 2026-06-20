const mongoose = require('mongoose');

// Set strictQuery before connection
mongoose.set('strictQuery', false);

// MongoDB connection - Configuration from environment variables
const isProd = process.env.NODE_ENV === 'production';

const MONGODB_CONFIG = isProd ? {
    url: process.env.MONGODB_URL,
    options: {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
    }
} : {
    url: process.env.MONGODB_URL || 'mongodb://localhost:27017/worldcup2026',
    options: {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
    }
};

// Defer the "Connecting" log until mongoose actually starts dialing, so the
// label matches the env that `loadEnvConfig` resolved to (not whatever was
// in process.env at the moment this module was first required). This also
// removes the duplicate "Connecting" line that happened when both the .once
// listener and the .then() on mongoose.connect() fired.
let didLogConnect = false;
function logConnecting() {
  if (didLogConnect) return;
  didLogConnect = true;
  const prod = process.env.NODE_ENV === 'production';
  console.log(`🔌 Connecting to MongoDB (${prod ? 'Production' : 'Development'}) — ${MONGODB_CONFIG.url}`);
}

mongoose.connect(MONGODB_CONFIG.url, MONGODB_CONFIG.options)
.then(() => {
    console.log("✅ Successful connection with MongoDB");
}).catch((err) => {
    console.log('❌ Error: Connection to MongoDB not successful', err.message);
    process.exit(1);
});

mongoose.connection.on('connecting', logConnecting);

mongoose.Promise = global.Promise;

module.exports = mongoose;
