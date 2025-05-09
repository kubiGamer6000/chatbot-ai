# Use Node.js 20 LTS as the base image for better performance and longer support
FROM node:20-alpine

# Install necessary tools
RUN apk add --no-cache bash curl

# Install pnpm and latest TypeScript globally
RUN npm install -g pnpm typescript@5.7.3

# Set the working directory
WORKDIR /app

# Copy package.json and pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Build the TypeScript application using global tsc
RUN pnpm run build

# Create necessary directories
RUN mkdir -p dist/.temp dist/.auth

# Expose the application port
EXPOSE 3002

# Create volume mounts for persistent data
VOLUME ["/app/dist/.auth", "/app/dist/.temp"]

# Run the application
CMD ["node", "dist/index.js"] 