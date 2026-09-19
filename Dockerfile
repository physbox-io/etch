# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Copy the entire project context
COPY . .

ARG GITHUB_TOKEN
ENV GITHUB_TOKEN=$GITHUB_TOKEN

# Build the frontend application
RUN npm install
# `build:image`, not `build`: the latter is `tsc -b && vite build`, and the
# typecheck half already ran in CI, which is what gates this image being built
# at all. Both tsconfigs are noEmit, so `tsc -b` produces nothing vite needs -
# running it here only repeats the check against the same lockfile, in a
# container with no cache, on every deploy.
RUN npm run build:image

# Production stage
FROM nginx:stable-alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Set default port for local testing or Cloud Run fallback
ENV PORT=8080

# Copy custom nginx config as a template for envsubst
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
