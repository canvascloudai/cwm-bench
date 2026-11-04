# Ingress is deny-by-default on a custom network. These are the only holes.
# Egress stays open so startup can install packages and reach Cloud SQL.

resource "google_compute_firewall" "health" {
  name          = "${local.name}-health-${local.id_slug}"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = local.health_ranges
  target_tags   = ["cwm-app"]

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
}

resource "google_compute_firewall" "iap_ssh" {
  name          = "${local.name}-iap-${local.id_slug}"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = [local.iap_range]
  target_tags   = ["cwm-app", "cwm-generator"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
