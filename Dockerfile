# syntax=docker/dockerfile:1
#
# pi-starter 沙箱镜像（官方 containerization 姿势）
# ------------------------------------------------------------------
# 官方 SDK 的硬隔离是"部署层"——把整个进程塞进容器（docs/containerization.md 的 Plain Docker）。
# 本镜像就是这样：pi-starter + guard 在容器里跑，容器边界替代宿主的进程/文件隔离。
#
# 构建：
#   docker build -t pi-starter .
# 运行（把宿主端口只绑到 127.0.0.1，别让容器无鉴权端口暴露到公网）：
#   docker run --rm -p 127.0.0.1:3000:3000 \
#     -v "$HOME/.pi/agent:/home/pi/.pi/agent:ro" \
#     -v "$PWD:/workspace" -w /workspace \
#     pi-starter
#   -> 浏览器/前端访问 http://127.0.0.1:3000
#
# 说明：
#   - PI_HOST 必须 0.0.0.0 才能让映射进来的宿主端口可达；服务本身无鉴权（by design），
#     所以务必像上面那样 `-p 127.0.0.1:3000:3000` 只绑本机回环，别用 -p 3000:3000 暴露公网。
#   - 运行时要读 ~/.pi/agent 的 models.json + auth.json（先在本机 `npm run setup` 写好再 :ro 挂进来）。
#   - 挂载 $PWD 到 /workspace 并 -w 进去：Agent 的 read/write/exec 就限制在该工作区内（配合 guard）。

FROM node:22-bookworm-slim

# ripgrep 供 grep 工具（readonly/coding 档）；git 供仓库操作；ca-certificates 供 HTTPS。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（含构建期 devDeps 与 optionalDependencies），再拷源码，利于层缓存。
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# 非 root 运行，别用宿主身份。
RUN useradd --create-home --uid 10001 pi && chown -R pi:pi /app
USER pi

ENV NODE_ENV=production \
    PI_HOST=0.0.0.0 \
    PI_BUILTIN_TOOLS=off

EXPOSE 3000

# 默认起 Web 服务（REST + SSE + WebSocket）。换 CLI 就覆盖 command。
CMD ["node", "dist/server.js"]
