RUN echo "THIS IS THE NEW DOCKERFILE"

# Use a standard Node.js image
FROM node:20-bookworm-slim

# Set the working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright browser dependencies (Chromium)
RUN npx playwright install --with-deps chromium

# Copy the rest of the application code
COPY . .

# Set environment variables
ENV PORT=3000

# Expose the API port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]