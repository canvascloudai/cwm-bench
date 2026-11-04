resource "google_compute_network" "main" {
  name                    = "${local.name}-${local.id_slug}"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "public" {
  name          = "${local.name}-public-${local.id_slug}"
  ip_cidr_range = local.public_cidr
  region        = var.region
  network       = google_compute_network.main.id
}

# Private subnet is local-only. Cloud SQL is reached over private services
# access, not through this subnet's default route.
resource "google_compute_subnetwork" "private" {
  name                     = "${local.name}-private-${local.id_slug}"
  ip_cidr_range            = local.private_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

resource "google_compute_global_address" "psa" {
  name          = "${local.name}-psa-${local.id_slug}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}
