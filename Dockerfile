# Transaction Firewall — container image.
# The app launches a real Anvil node (forking Sepolia) and deploys contracts on
# startup, so the image needs Foundry's `anvil` on the PATH. Node runs the TS
# server directly via tsx (no build step — contract artifacts are committed).
FROM node:22-bookworm-slim

# System deps: curl/git for foundryup, ca-certificates for outbound RPC/TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install Foundry (anvil, forge, cast) onto the PATH.
ENV PATH="/root/.foundry/bin:${PATH}"
RUN curl -L https://foundry.paradigm.xyz | bash \
 && foundryup

WORKDIR /app

# Install dependencies first (better layer caching). tsx/typescript are needed
# at runtime, so keep dev dependencies.
COPY package*.json ./
RUN npm install

# App source (contract artifacts under src/chain are committed, so no forge build).
COPY . .

# Host platforms inject PORT; the server reads it (defaults to 4780 locally).
ENV PORT=4780
EXPOSE 4780

CMD ["npm", "run", "start"]
