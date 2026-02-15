FROM docker.elastic.co/elasticsearch/elasticsearch:8.11.0

# Disable X-Pack security for hackathon simplicity
ENV xpack.security.enabled=false
ENV discovery.type=single-node

# Reduce memory usage for free tier
ENV ES_JAVA_OPTS="-Xms256m -Xmx256m"

# Expose ports
EXPOSE 9200 9300

# Health check
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:9200/_cluster/health || exit 1