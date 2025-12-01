FROM debian:12.5-slim

EXPOSE 80
WORKDIR /home

# Install dependencies including build tools for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    python3 \
    make \
    g++ \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fSL -o node.tar.gz https://nodejs.org/dist/v18.19.0/node-v18.19.0-linux-x64.tar.gz \
    && mkdir -p /usr/local/nodejs \
    && tar -xzf node.tar.gz -C /usr/local/nodejs --strip-components=1 \
    && rm node.tar.gz \
    && ln -s /usr/local/nodejs/bin/node /usr/local/bin/node \
    && ln -s /usr/local/nodejs/bin/npm /usr/local/bin/npm

# Download from your GitHub repo
RUN curl -L -o hnzby.zip https://github.com/charles-bukow/hnzby/archive/refs/heads/main.zip \
    && unzip hnzby.zip \
    && mv hnzby-main/* . \
    && rm -rf hnzby-main hnzby.zip

# Install dependencies
RUN npm install --omit=dev

# Environment variables with YOUR Hydra instance
ENV NODE_ENV=production \
    PORT=80 \
    HYDRA_URL=http://62.210.211.193:5076 \
    HYDRA_API_KEY=SRNVOR1TH81MGHM1EAV7U3CUKO \
    TMDB_API_KEY=96ca5e1179f107ab7af156b0a3ae9ca5 \
    NNTP_SERVERS=nntps://3F6591F2304B:U9ZfUr%25sX%5DW%3F%5D%2CdH%40Z_7@news.newsgroup.ninja:563/4,nntps://7b556e9dea40929b:v3jRQvKuy89URx3qD3@news.eweka.nl:563/4,nntps://uf19e250c9a87c061e7e:48493ff7a57f4178c64f90@news.usenet.farm:563/4,nntps://uf2bcd47415c28035462:778a7249cccf175fb5d114@news.usenet.farm:563/4,nntps://aiv575755466:287962398@news.newsgroupdirect.com:563/4,nntps://unp8736765:Br1lliant!P00p@news.usenetprime.com:563/4

# Start server
CMD ["node", "server.js"]
