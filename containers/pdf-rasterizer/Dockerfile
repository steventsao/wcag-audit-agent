# syntax=docker/dockerfile:1
# PDF rasterizer: shells out to MuPDF `mutool draw` for per-page PNG rendering.

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
WORKDIR /app
COPY go.mod .
COPY main.go .
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -o /server main.go

FROM alpine:3.19
RUN apk add --no-cache mupdf-tools ca-certificates \
  && adduser -D -u 10001 app
COPY --from=build /server /server
USER app
EXPOSE 8080
CMD ["/server"]
