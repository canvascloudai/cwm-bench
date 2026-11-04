resource "google_compute_health_check" "app" {
  name = "${local.name}-app-${local.id_slug}"

  http_health_check {
    port         = 8080
    request_path = "/health"
  }
}

resource "google_compute_backend_service" "app" {
  name                  = "${local.name}-app-${local.id_slug}"
  protocol              = "HTTP"
  port_name             = "http"
  timeout_sec           = 30
  load_balancing_scheme = "EXTERNAL_MANAGED"
  health_checks         = [google_compute_health_check.app.id]

  backend {
    group           = google_compute_region_instance_group_manager.app.instance_group
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1
  }
}

resource "google_compute_url_map" "app" {
  name            = "${local.name}-app-${local.id_slug}"
  default_service = google_compute_backend_service.app.id
}

resource "google_compute_target_http_proxy" "app" {
  name    = "${local.name}-app-${local.id_slug}"
  url_map = google_compute_url_map.app.id
}

resource "google_compute_global_address" "lb" {
  name         = "${local.name}-lb-${local.id_slug}"
  address_type = "EXTERNAL"
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${local.name}-http-${local.id_slug}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.address
  port_range            = "80"
  target                = google_compute_target_http_proxy.app.id
  labels = {
    project    = "cwm-bench"
    test_id    = local.id_slug
    managed_by = "terraform"
  }
}

# HTTPS only when the caller supplies a certificate. Nothing in this repo is a cert.
resource "google_compute_target_https_proxy" "app" {
  count            = var.https_certificate == "" ? 0 : 1
  name             = "${local.name}-https-${local.id_slug}"
  url_map          = google_compute_url_map.app.id
  ssl_certificates = [var.https_certificate]
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = var.https_certificate == "" ? 0 : 1
  name                  = "${local.name}-https-${local.id_slug}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb.address
  port_range            = "443"
  target                = google_compute_target_https_proxy.app[0].id
  labels = {
    project    = "cwm-bench"
    test_id    = local.id_slug
    managed_by = "terraform"
  }
}
