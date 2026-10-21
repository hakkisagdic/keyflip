FROM node:20-alpine

RUN apk add --no-cache \
    git \
    sqlite \
    bash

WORKDIR /keyflip

# Install dependencies
RUN npm ci --production

# Create a non-root user
RUN addgroup -g 1000 keyflip && \
    adduser -u 1000 -G keyflip -s /bin/sh -D keyflip

USER keyflip

CMD ["sh"]
