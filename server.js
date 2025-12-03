// ============================================================================
// NZBio Stremio Addon - Node.js Server (Direct Indexer Edition)
// Stream movies and series from Usenet via direct indexer API calls
// ============================================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Direct Indexers
  indexers: [
    {
      name: 'NZBPlanet',
      url: 'https://nzbplanet.net/api',
      apiKey: 'bacb2bb2b6e39031c8cc87d541eb2208'
    },
    {
      name: 'DrunkenSlug',
      url: 'https://drunkenslug.com/api',
      apiKey: '1ea43e3299e9d7f8197e47cbf54339ad'
    },
    {
      name: 'NZBGeek',
      url: 'https://api.nzbgeek.info/api',
      apiKey: 'D82cPAexiYCGwVPr2AOWusCR1830ls2y'
    }
  ],
  
  // TMDB API Key
  tmdbApiKey: '96ca5e1179f107ab7af156b0a3ae9ca5',
  
  // NNTP Servers
  nntpServers: [
    'nntps://3F6591F2304B:U9ZfUr%25sX%5DW%3F%5D%2CdH%40Z_7@news.newsgroup.ninja:563/4',
    'nntps://7b556e9dea40929b:v3jRQvKuy89URx3qD3@news.eweka.nl:563/4',
    'nntps://uf19e250c9a87c061e7e:48493ff7a57f4178c64f90@news.usenet.farm:563/4',
    'nntps://uf2bcd47415c28035462:778a7249cccf175fb5d114@news.usenet.farm:563/4',
    'nntps://aiv575755466:287962398@news.newsgroupdirect.com:563/4',
    'nntps://unp8736765:Br1lliant!P00p@news.usenetprime.com:563/4'
  ],
  
  // Content Settings
  retentionDays: 365,
  searchTimeout: 15000,
  tmdbTimeout: 10000,
  
  // Server Settings
  port: process.env.PORT || 80
};

// ============================================================================
// MANIFEST
// ============================================================================

const MANIFEST = {
  id: 'org.stremio.nzbio.direct',
  name: 'NZBio Direct',
  version: '3.0.0',
  description: 'Stream from Usenet via direct indexer connections (no Hydra)',
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
 * Make HTTPS request with timeout
 */
function httpsGet(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('Request timeout'));
    }, timeout);

    const req = https.get(url, { headers: { 'User-Agent': 'NZBio/3.0' } }, (res) => {
      clearTimeout(timer);
      let data = '';
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Convert IMDb ID to TMDB metadata
 */
async function getMetadata(imdbId) {
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${CONFIG.tmdbApiKey}&external_source=imdb_id`;
    const data = await httpsGet(url, CONFIG.tmdbTimeout);
    const json = JSON.parse(data);
    
    // Check for movie
    if (json.movie_results?.length > 0) {
      const movie = json.movie_results[0];
      return {
        tmdbId: movie.id,
        title: movie.title,
        year: movie.release_date ? new Date(movie.release_date).getFullYear() : '',
        type: 'movie'
      };
    }
    
    // Check for TV series
    if (json.tv_results?.length > 0) {
      const show = json.tv_results[0];
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
 * Search a single indexer
 */
async function searchIndexer(indexer, query) {
  try {
    const searchUrl = `${indexer.url}?apikey=${indexer.apiKey}&t=search&q=${encodeURIComponent(query)}&extended=1`;
    
    console.log(`Searching ${indexer.name}...`);
    
    const xmlText = await httpsGet(searchUrl, CONFIG.searchTimeout);
    const items = parseXML(xmlText);
    
    console.log(`${indexer.name} returned ${items.length} results`);
    
    // Tag items with indexer name
    return items.map(item => ({
      ...item,
      indexer: indexer.name
    }));
    
  } catch (error) {
    console.error(`${indexer.name} error:`, error.message);
    return [];
  }
}

/**
 * Search all indexers in parallel
 */
async function searchAllIndexers(query) {
  try {
    console.log(`Searching all indexers for: "${query}"`);
    
    // Search all indexers simultaneously
    const results = await Promise.all(
      CONFIG.indexers.map(indexer => searchIndexer(indexer, query))
    );
    
    // Flatten all results
    const allItems = results.flat();
    
    console.log(`Total results from all indexers: ${allItems.length}`);
    
    // Remove duplicates by title
    const uniqueItems = Array.from(
      new Map(allItems.map(item => [item.title.toLowerCase(), item])).values()
    );
    
    console.log(`Unique results after deduplication: ${uniqueItems.length}`);
    
    // Filter by retention
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - CONFIG.retentionDays);
    
    const filtered = uniqueItems.filter(item => {
      if (!item.pubDate) return true;
      const itemDate = new Date(item.pubDate);
      return !isNaN(itemDate.getTime()) && itemDate >= cutoffDate;
    });
    
    console.log(`Results after retention filter: ${filtered.length}`);
    
    return filtered;
    
  } catch (error) {
    console.error('Search all indexers error:', error.message);
    return [];
  }
}

/**
 * Parse XML response from indexers
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
    
    // Extract size
    let sizeInBytes = 0;
    const enclosureMatch = itemContent.match(/<enclosure[^>]*length="(\d+)"[^>]*>/i);
    if (enclosureMatch) {
      sizeInBytes = parseInt(enclosureMatch[1], 10);
    }
    
    // Format size
    let size = 'Unknown';
    if (sizeInBytes > 1024 * 1024 * 1024) {
      size = `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (sizeInBytes > 1024 * 1024) {
      size = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    
    // Extract quality markers
    const qualityRegex = /(4K|2160p|1080p|720p|480p|HDTV|WEB-DL|BluRay|HEVC|x265|H\.265|H264|x264)/gi;
    const qualityMatches = title.match(qualityRegex) || [];
    
    // Extract category
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
 * Extract XML tag value and decode HTML entities
 */
function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  
  // Decode HTML entities
  const value = match[1].trim();
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Create stream objects from NZB results
 */
function createStreams(nzbResults, metadata) {
  const streams = nzbResults.map(nzb => {
    // Determine quality tier
    const qualityMatch = nzb.quality.match(/(4K|2160p|1080p|720p|480p)/i);
    const quality = qualityMatch ? qualityMatch[1] : 'SD';
    
    // Build description
    const description = [
      `📺 ${metadata.title}`,
      `🔍 ${nzb.indexer}`,
      `🎥 ${nzb.category}`,
      `📦 ${nzb.size}`,
      nzb.quality ? `🎬 ${nzb.quality}` : null
    ].filter(Boolean).join('\n');
    
    // Create binge group
    const bingeGroup = `org.stremio.nzbio.direct|${quality.toLowerCase()}|${nzb.category.toLowerCase().replace(/\s+/g, '-')}`;
    
    return {
      name: `NZB ${quality} [${nzb.indexer}]`,
      description,
      nzbUrl: nzb.link,
      servers: CONFIG.nntpServers,
      behaviorHints: {
        notWebReady: true,
        filename: nzb.title,
        videoSize: nzb.sizeInBytes || undefined,
        bingeGroup
      }
    };
  });
  
  // Sort by quality preference
  const qualityOrder = { '1080p': 1, '720p': 2, '2160p': 3, '4K': 3, '480p': 4 };
  
  return streams.sort((a, b) => {
    const getQuality = (stream) => {
      for (const quality in qualityOrder) {
        if (stream.name.includes(quality)) return qualityOrder[quality];
      }
      return 999;
    };
    return getQuality(a) - getQuality(b);
  });
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Handle manifest.json request
 */
function handleManifest() {
  return MANIFEST;
}

/**
 * Handle stream request
 */
async function handleStream(type, id) {
  try {
    // Decode URL-encoded ID
    const decodedId = decodeURIComponent(id);
    console.log(`\n=== Stream Request: ${type}/${decodedId} ===`);
    
    // Parse request
    let imdbId = decodedId;
    let season, episode;
    
    if (type === 'series' && decodedId.includes(':')) {
      [imdbId, season, episode] = decodedId.split(':');
    }
    
    if (!imdbId.startsWith('tt')) {
      console.log('Invalid IMDb ID:', imdbId);
      return { streams: [] };
    }
    
    // Get metadata from TMDB
    console.log('Fetching TMDB metadata...');
    const metadata = await getMetadata(imdbId);
    if (!metadata) {
      console.log('No TMDB metadata found');
      return { streams: [] };
    }
    
    console.log(`Found: ${metadata.title} (${metadata.year})`);
    
    // Build search query
    let searchQuery;
    if (type === 'movie') {
      searchQuery = `${metadata.title} ${metadata.year}`;
    } else {
      searchQuery = `${metadata.title} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
    }
    
    console.log(`Search query: "${searchQuery}"`);
    
    // Search all indexers
    const nzbResults = await searchAllIndexers(searchQuery);
    
    if (!nzbResults || nzbResults.length === 0) {
      console.log('No results found from any indexer');
      return { streams: [] };
    }
    
    // Create and return streams
    const streams = createStreams(nzbResults, metadata);
    console.log(`Returning ${streams.length} streams to Stremio`);
    console.log('=== Request Complete ===\n');
    
    return { streams };
    
  } catch (error) {
    console.error('Stream handler error:', error);
    return { streams: [] };
  }
}

// ============================================================================
// HTTP SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  
  try {
    // Route: /manifest.json
    if (path === '/manifest.json' || path === '/') {
      const manifest = handleManifest();
      res.writeHead(200);
      res.end(JSON.stringify(manifest));
      return;
    }
    
    // Route: /stream/:type/:id.json
    const streamMatch = path.match(/^\/stream\/(movie|series)\/([^\/]+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      const result = await handleStream(type, id);
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }
    
    // Default: return manifest
    const manifest = handleManifest();
    res.writeHead(200);
    res.end(JSON.stringify(manifest));
    
  } catch (error) {
    console.error('Server error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// ============================================================================
// START SERVER
// ============================================================================

server.listen(CONFIG.port, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           NZBio Direct - Stremio Addon Server             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Server running on port: ${CONFIG.port}${' '.repeat(32 - CONFIG.port.toString().length)}║`);
  console.log(`║  Manifest URL: http://localhost:${CONFIG.port}/manifest.json${' '.repeat(12 - CONFIG.port.toString().length)}║`);
  console.log('║                                                            ║');
  console.log(`║  Indexers configured: ${CONFIG.indexers.length}${' '.repeat(33)}║`);
  CONFIG.indexers.forEach(indexer => {
    console.log(`║    - ${indexer.name}${' '.repeat(50 - indexer.name.length)}║`);
  });
  console.log('║                                                            ║');
  console.log('║  Ready to stream from Usenet! 🚀                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
});