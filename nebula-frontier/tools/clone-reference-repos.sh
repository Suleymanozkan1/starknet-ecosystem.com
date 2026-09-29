#!/usr/bin/env bash
# Clones the reference repositories (NOT production dependencies) into tools/reference-repos.
set -euo pipefail
cd "$(dirname "$0")/reference-repos"
repos=(colyseus/tutorial-phaser halftheopposite/tosios knagaitsev/io-template phaserjs/phaser colyseus/colyseus anza-xyz/kit anza-xyz/wallet-adapter metaplex-foundation/mpl-token-metadata solana-foundation/anchor prisma/prisma)
for r in "${repos[@]}"; do
  name=$(basename "$r")
  if [ -d "$name/.git" ]; then git -C "$name" pull --ff-only -q || true; else git clone -q --depth 1 --filter=blob:limit=2m "https://github.com/$r" "$name"; fi
  echo "✓ $name @ $(git -C "$name" rev-parse --short HEAD)"
done
