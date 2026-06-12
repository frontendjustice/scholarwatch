#!/bin/bash
export HOME=/home/nebula
export PYTHONPATH=/home/nebula/.local/lib/python3.14/site-packages
export PATH=/home/nebula/.local/bin:$PATH

# Load API keys (ANTHROPIC_API_KEY etc.)
if [ -f /home/nebula/.nebula-env ]; then
  set -a
  source /home/nebula/.nebula-env
  set +a
fi

cd /home/nebula/.miniapps/bin/mapp_06a21f9b83877d718000b35f2ac0f511
exec /home/nebula/.local/bin/uvicorn server:app --host 0.0.0.0 --port 8080
