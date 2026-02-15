FROM docker.elastic.co/elasticsearch/elasticsearch:9.2.0

# Disable X-Pack security for hackathon simplicity
ENV xpack.security.enabled=false
ENV xpack.license.self_generated.type=trial
ENV discovery.type=single-node

# Expose ports
EXPOSE 9200 9300

# Health check
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:9200/_cluster/health || exit 1