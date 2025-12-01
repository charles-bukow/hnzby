// ============================================================================
// NZBio Stremio Addon - Node.js Server with NNTP Proxy
// Stream movies and series from Usenet via NZB sources
// ============================================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');
const xml2js = require('xml2js');
const nntp = require('nntp');
const yencoded = require('yencoded');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  port: process.env.PORT || 80,
  
  // NZB Hydra Settings
  hydraUrl: process.env.HYDRA_URL || 'http://nzbhy.duckdns.org:31013',
  hydraApiKey: process.env.HYDRA_API_KEY || '5CB1HJJFVNV31AQ23M089DP3BN',
  
  // TMDB API Key
  tmdbApiKey: process.env.TMDB_API_KEY || '96ca5e1179f107ab7af156b0a3ae9ca5',
  
  // NNTP Servers - Parse from environment or use defaults
  nntpServers: parseNNTPServers(process.env.NNTP_SERVERS || 
    'nntps://3F6591F2304B:U9ZfUr%25sX%5DW%3F%5D%2CdH%40Z_7@news.newsgroup.ninja:563/4,' +
    'nntps://7b556e9dea40929b:v3jRQvKuy89URx3qD3@news.eweka.nl:563/4,' +
    'nntps://uf19e250c9a87c061e7e:48493ff7a57f4178c64f90@news.usenet.farm:563/4,' +
    'nntps://uf2bcd47415c28035462:778a7249cccf175fb5d114@news.usenet.farm:563/4,' +
    'nntps://aiv575755466:287962398@news.newsgroupdirect.com:563/4,' +
    'nntps://unp8736765:Br1lliant!P00p@news.usenetprime.com:563/4'
  ),
  
  // Content Settings
  searchTimeout: 15000,
  tmdbTimeout: 10000,
  nzbTimeout: 30000,
  proxyTimeout: 600000 // 10 minutes for video streaming
};

/**
 * Parse NNTP server URIs into config objects
 * Format: nntps://user:pass@host:port/connections
 */
function parseNNTPServers(serversString) {
  const servers = serversString.split(',').map(uri => {
    try {
      const url = new URL(uri.trim());
      return {
        host: url.hostname,
        port: parseInt(url.port) || 563,
        secure: url.protocol === 'nntps:',
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        connections: parseInt(url.pathname.slice(1)) || 4
      };
    } catch (err) {
      console.error('Failed to parse NNTP server URI:', uri, err.message);
      return null;
    }
  }).filter(Boolean);
  
  if (servers.length === 0) {
    console.error('No valid NNTP servers configured!');
  }
  
  return servers;
}

// ============================================================================
// MANIFEST
// ============================================================================

const MANIFEST = {
  id: 'org.stremio.nzbio.deploycx',
  name: 'NZBio',
  version: '2.0.0',
  description: 'Stream movies and series directly from Usenet via NZB sources',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  logo: 'https://i.imgur.com/GgJcJVw.png',
  background: 'https://i.imgur.com/yqlDCaC.jpg',
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Make HTTP(S) request
 */
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const timeout = setTimeout(() => {
      reject(new Error('Request timeout'));
    }, options.timeout || 15000);
    
    const req = client.get(url, options, (res) => {
      clearTimeout(timeout);
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Download binary data (for NZB files)
 */
function downloadBinary(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const timeout = setTimeout(() => {
      reject(new Error('Download timeout'));
    }, CONFIG.nzbTimeout);
    
    const req = client.get(url, (res) => {
      clearTimeout(timeout);
      
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Parse NZB file
 */
async function parseNZB(nzbData) {
  const parser = new xml2js.Parser();
  const result = await parser.parseStringPromise(nzbData);
  
  const files = [];
  
  if (result.nzb && result.nzb.file) {
    for (const file of result.nzb.file) {
      const segments = [];
      
      if (file.segments && file.segments[0] && file.segments[0].segment) {
        for (const segment of file.segments[0].segment) {
          segments.push({
            number: parseInt(segment.$.number),
            bytes: parseInt(segment.$.bytes),
            messageId: segment._
          });
        }
      }
      
      // Sort segments by number
      segments.sort((a, b) => a.number - b.number);
      
      files.push({
        poster: file.$.poster || 'unknown',
        date: file.$.date || '',
        subject: file.$.subject || 'unknown',
        segments: segments
      });
    }
  }
  
  return files;
}

/**
 * Connect to NNTP server
 */
function connectNNTP(serverConfig) {
  return new Promise((resolve, reject) => {
    const client = new nntp.NNTPClient(serverConfig.port, serverConfig.host, {
      secure: serverConfig.secure
    });
    
    client.on('connect', async () => {
      try {
        if (serverConfig.user && serverConfig.password) {
          await client.authinfo(serverConfig.user, serverConfig.password);
        }
        resolve(client);
      } catch (err) {
        reject(err);
      }
    });
    
    client.on('error', reject);
  });
}

/**
 * Download article from NNTP
 */
async function downloadArticle(client, messageId) {
  return new Promise((resolve, reject) => {
    client.article(messageId, (err, responseCode, data) => {
      if (err) return reject(err);
      if (responseCode !== 220) return reject(new Error(`NNTP error: ${responseCode}`));
      resolve(data);
    });
  });
}

/**
 * Decode yEnc data
 */
function decodeYenc(data) {
  try {
    const decoded = yencoded.decode(data);
    return decoded;
  } catch (err) {
    console.error('yEnc decode error:', err.message);
    return null;
  }
}

/**
 * Convert IMDb ID to TMDB metadata
 */
async function getMetadata(imdbId) {
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${CONFIG.tmdbApiKey}&external_source=imdb_id`;
    const response = await makeRequest(url, { timeout: CONFIG.tmdbTimeout });
    
    if (response.status !== 200) return null;
    
    const data = JSON.parse(response.data);
    
    if (data.movie_results?.length > 0) {
      const movie = data.movie_results[0];
      return {
        tmdbId: movie.id,
        title: movie.title,
        year: movie.release_date ? new Date(movie.release_date).getFullYear() : '',
        type: 'movie'
      };
    }
    
    if (data.tv_results?.length > 0) {
      const show = data.tv_results[0];
      return {
        tmdbId: show.id,
        title: show.name,
        year: show.first_air_date ? new Date(show.first_air_date).getFullYear() : '',
        type: 'series'
      };
    }
    
    return null;
  } catch (error) {
    console.error('TMDB lookup failed:', error.message);
    return null;
  }
}

/**
 * Search NZB Hydra for content
 */
async function searchNZB(query) {
  try {
    const apiUrl = CONFIG.hydraUrl.endsWith('/api') 
      ? CONFIG.hydraUrl 
      : `${CONFIG.hydraUrl}/api`;
    
    const searchUrl = `${apiUrl}?apikey=${CONFIG.hydraApiKey}&t=search&q=${encodeURIComponent(query)}`;
    
    const response = await makeRequest(searchUrl, {
      timeout: CONFIG.searchTimeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/xml, application/rss+xml, text/xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    if (response.status !== 200) {
      console.error(`NZB search failed: ${response.status}`);
      return [];
    }
    
    const items = parseXML(response.data);
    return items;
    
  } catch (error) {
    console.error('NZB search error:', error.message);
    return [];
  }
}

/**
 * Parse XML response from NZB Hydra
 */
function parseXML(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemContent = match[1];
    
    const title = extractTag(itemContent, 'title');
    const link = extractTag(itemContent, 'link');
    const pubDate = extractTag(itemContent, 'pubDate');
    
    let sizeInBytes = 0;
    const enclosureMatch = itemContent.match(/<enclosure[^>]*length="(\d+)"[^>]*>/i);
    if (enclosureMatch) {
      sizeInBytes = parseInt(enclosureMatch[1], 10);
    }
    
    let size = 'Unknown';
    if (sizeInBytes > 1024 * 1024 * 1024) {
      size = `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (sizeInBytes > 1024 * 1024) {
      size = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    
    const qualityRegex = /(4K|2160p|1080p|720p|480p|HDTV|WEB-DL|BluRay|HEVC|x265|H\.265|H264|x264)/gi;
    const qualityMatches = title.match(qualityRegex) || [];
    
    const category = extractTag(itemContent, 'category') || 'Unknown';
    
    items.push({
      title,
      link,
      pubDate,
      sizeInBytes,
      size,
      quality: qualityMatches.join(' '),
      category
    });
  }
  
  return items;
}

/**
 * Extract XML tag value
 */
function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Get quality tier for sorting
 */
function getQualityTier(qualityString) {
  const upper = qualityString.toUpperCase();
  
  if (upper.includes('4K') || upper.includes('2160P')) return 5;
  if (upper.includes('1080P')) return 4;
  if (upper.includes('720P')) return 3;
  if (upper.includes('480P')) return 2;
  return 1;
}

/**
 * Create stream objects from NZB results
 */
function createStreams(nzbResults, metadata, baseUrl) {
  const streams = nzbResults.map(nzb => {
    const qualityMatch = nzb.quality.match(/(4K|2160p|1080p|720p|480p)/i);
    const quality = qualityMatch ? qualityMatch[1] : 'SD';
    
    const description = [
      `Title: ${metadata.title}`,
      `Category: ${nzb.category}`,
      `Size: ${nzb.size}`,
      nzb.quality ? `Quality: ${nzb.quality}` : null
    ].filter(Boolean).join('\n');
    
    const bingeGroup = `org.stremio.nzbio|${quality.toLowerCase()}|${nzb.category.toLowerCase().replace(/\s+/g, '-')}`;
    
    // Use proxy URL instead of direct NZB link
    const proxyUrl = `${baseUrl}/proxy?nzb=${encodeURIComponent(nzb.link)}`;
    
    return {
      name: `NZBio ${quality}`,
      description,
      url: proxyUrl,  // NNTP proxy URL
      qualityTier: getQualityTier(nzb.quality),
      sizeInBytes: nzb.sizeInBytes || 0,
      behaviorHints: {
        notWebReady: false,  // Now it IS web-ready via proxy
        filename: nzb.title,
        videoSize: nzb.sizeInBytes || undefined,
        bingeGroup
      }
    };
  });
  
  return streams.sort((a, b) => {
    if (a.qualityTier !== b.qualityTier) {
      return b.qualityTier - a.qualityTier;
    }
    return b.sizeInBytes - a.sizeInBytes;
  });
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Handle manifest request
 */
function handleManifest(req, res) {
  sendJSON(res, MANIFEST);
}

/**
 * Handle stream request
 */
async function handleStream(req, res, type, id, baseUrl) {
  try {
    const decodedId = decodeURIComponent(id);
    console.log(`Stream request: ${type}/${decodedId}`);
    
    let imdbId = decodedId;
    let season, episode;
    
    if (type === 'series' && decodedId.includes(':')) {
      [imdbId, season, episode] = decodedId.split(':');
    }
    
    if (!imdbId.startsWith('tt')) {
      console.log('Invalid IMDb ID:', imdbId);
      return sendJSON(res, { streams: [] });
    }
    
    const metadata = await getMetadata(imdbId);
    if (!metadata) {
      console.log('No TMDB metadata found for:', imdbId);
      return sendJSON(res, { streams: [] });
    }
    
    console.log('Found metadata:', metadata.title, metadata.year);
    
    let searchQuery;
    if (type === 'movie') {
      searchQuery = `${metadata.title} ${metadata.year}`;
    } else {
      searchQuery = `${metadata.title} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
    }
    
    console.log('Searching NZB for:', searchQuery);
    
    const nzbResults = await searchNZB(searchQuery);
    
    if (!nzbResults || nzbResults.length === 0) {
      console.log('No NZB results found');
      return sendJSON(res, { streams: [] });
    }
    
    console.log(`Found ${nzbResults.length} NZB results`);
    
    const streams = createStreams(nzbResults, metadata, baseUrl);
    console.log(`Returning ${streams.length} streams`);
    
    sendJSON(res, { streams });
    
  } catch (error) {
    console.error('Stream handler error:', error);
    sendJSON(res, { streams: [] });
  }
}

/**
 * Handle NNTP proxy request
 */
async function handleProxy(req, res, nzbUrl) {
  try {
    console.log('Proxy request for NZB:', nzbUrl);
    
    // Download NZB file
    console.log('Downloading NZB...');
    const nzbData = await downloadBinary(nzbUrl);
    
    // Parse NZB
    console.log('Parsing NZB...');
    const files = await parseNZB(nzbData);
    
    if (!files || files.length === 0) {
      throw new Error('No files found in NZB');
    }
    
    console.log(`Found ${files.length} file(s) in NZB`);
    
    // Find the largest video file (usually the main video)
    const videoFile = files.reduce((largest, file) => {
      const fileSize = file.segments.reduce((sum, seg) => sum + seg.bytes, 0);
      const largestSize = largest ? largest.segments.reduce((sum, seg) => sum + seg.bytes, 0) : 0;
      return fileSize > largestSize ? file : largest;
    }, null);
    
    if (!videoFile) {
      throw new Error('No video file found');
    }
    
    console.log(`Streaming file: ${videoFile.subject} (${videoFile.segments.length} segments)`);
    
    // Connect to NNTP
    console.log('Connecting to NNTP...');
    const nntpClient = await connectNNTP(CONFIG.nntpServers[0]);
    
    // Set response headers for video streaming
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    
    // Download and stream segments
    for (let i = 0; i < videoFile.segments.length; i++) {
      const segment = videoFile.segments[i];
      
      console.log(`Downloading segment ${i + 1}/${videoFile.segments.length}: ${segment.messageId}`);
      
      try {
        const articleData = await downloadArticle(nntpClient, segment.messageId);
        const decodedData = decodeYenc(articleData);
        
        if (decodedData) {
          res.write(decodedData);
        } else {
          console.error(`Failed to decode segment ${i + 1}`);
        }
      } catch (err) {
        console.error(`Error downloading segment ${i + 1}:`, err.message);
        // Continue with next segment
      }
    }
    
    // Close connection
    nntpClient.quit();
    res.end();
    
    console.log('Stream complete');
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${error.message}`);
  }
}

/**
 * Send JSON response
 */
function sendJSON(res, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  
  // Get base URL for proxy links
  const baseUrl = `http://${req.headers.host}`;
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }
  
  // Route: /manifest.json or /
  if (path === '/manifest.json' || path === '/') {
    return handleManifest(req, res);
  }
  
  // Route: /proxy?nzb=<url>
  if (path === '/proxy') {
    const nzbUrl = url.searchParams.get('nzb');
    if (!nzbUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Missing nzb parameter');
    }
    return handleProxy(req, res, decodeURIComponent(nzbUrl));
  }
  
  // Route: /stream/:type/:id.json
  const streamMatch = path.match(/^\/stream\/(movie|series)\/([^\/]+)\.json$/);
  if (streamMatch) {
    const [, type, id] = streamMatch;
    return handleStream(req, res, type, id, baseUrl);
  }
  
  // Default: return manifest
  handleManifest(req, res);
});

// Start server
server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`NZBio Stremio Addon with NNTP Proxy running on port ${CONFIG.port}`);
  console.log(`Manifest: http://localhost:${CONFIG.port}/manifest.json`);
  console.log(`Proxy: http://localhost:${CONFIG.port}/proxy?nzb=<url>`);
});