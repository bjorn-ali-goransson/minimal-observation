# Build the React UI, build the pure-Go server, ship a tiny static image.
FROM node:22-slim AS ui
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @mo/ui build

FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY sqlite-server/go.mod sqlite-server/go.sum ./
RUN go mod download
COPY sqlite-server/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /moserver .

FROM gcr.io/distroless/static-debian12
COPY --from=build /moserver /moserver
COPY --from=ui /app/packages/ui/dist /ui
ENV MO_PORT=4318 \
    MO_DATA_DIR=/data \
    MO_UI_DIR=/ui
VOLUME /data
EXPOSE 4318
ENTRYPOINT ["/moserver"]
