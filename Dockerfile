FROM debian:12.5-slim
EXPOSE 80
WORKDIR /home

# Install minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fSL -o node.tar.gz https://nodejs.org/dist/v18.19.0/node-v18.19.0-linux-x64.tar.gz \
    && mkdir -p /usr/local/nodejs \
    && tar -xzf node.tar.gz -C /usr/local/nodejs --strip-components=1 \
    && rm node.tar.gz \
    && ln -s /usr/local/nodejs/bin/node /usr/local/bin/node \
    && ln -s /usr/local/nodejs/bin/npm /usr/local/bin/npm

# Download app from GitHub
RUN curl -L -o hnzby.zip https://github.com/charles-bukow/hnzby/archive/refs/heads/main.zip \
    && unzip hnzby.zip \
    && mv hnzby-main*/* . \
    && rm -rf hnzby-main* hnzby.zip

# Copy package files
COPY package.json ./
COPY server.js ./

# Install dependencies
RUN npm install --omit=dev

# Start server
CMD ["node", "server.js"]