# Stage 1: Build the Rust key extractor
FROM rust:1.75-slim AS rust-builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy Rust project files
COPY rust-key-extractor/ ./rust-key-extractor/

# Build the Rust key extractor in release mode
RUN cd rust-key-extractor && cargo build --release

# Stage 2: Build the Node.js application
FROM node:20-slim AS node-builder

WORKDIR /app

# Copy package files
COPY package.json yarn.lock* package-lock.json* ./

# Install dependencies
RUN if [ -f yarn.lock ]; then yarn install --production=false; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

# Copy source files
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Stage 3: Production image
FROM node:20-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    bash \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Copy the Rust binary from the build stage
COPY --from=rust-builder /app/rust-key-extractor/target/release/sled-key-extractor /usr/local/bin/key-extractor

# Copy package files and install production dependencies only
COPY package.json yarn.lock* package-lock.json* ./
RUN if [ -f yarn.lock ]; then yarn install --production; \
    elif [ -f package-lock.json ]; then npm ci --only=production; \
    else npm install --only=production; fi

# Copy built application
COPY --from=node-builder /app/lib ./lib/
COPY scripts/ ./scripts/

# Make scripts executable
RUN chmod +x scripts/*.sh /usr/local/bin/key-extractor

# Create a directory for migration working files
RUN mkdir -p /migration

# Set environment variable defaults
ENV MIGRATION_DIR=/migration
ENV NODE_ENV=production

# Add labels
LABEL org.opencontainers.image.source="https://github.com/ixofoundation/sled-migration-tool"
LABEL org.opencontainers.image.description="Tool to migrate Matrix bot Sled crypto stores to SQLite"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Set the entrypoint
ENTRYPOINT ["node", "lib/index.js"]

# Default command shows help
CMD ["--help"]
