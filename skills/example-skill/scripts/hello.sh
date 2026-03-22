#!/bin/bash
echo "Hello from example-skill!"
echo "Environment: $(uname -s) $(uname -m)"
echo "Node: $(node --version 2>/dev/null || echo 'not found')"
