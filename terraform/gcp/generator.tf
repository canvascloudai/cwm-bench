resource "google_compute_instance" "generator" {
  name         = "${local.name}-gen-${local.id_slug}"
  machine_type = var.generator_machine_type
  zone         = var.zone
  tags         = ["cwm-generator"]

  boot_disk {
    initialize_params {
      image = var.app_image
      type  = "pd-balanced"
      size  = 30
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.public.id
    access_config {}
  }

  metadata_startup_script = templatefile("${path.module}/userdata/generator.sh.tftpl", {
    alb_dns            = google_compute_global_address.lb.address
    k6_version         = var.k6_version
    git_url            = var.app_source_git_url
    git_ref            = var.app_source_git_ref
    test_id            = var.test_id
    scenarios_js_b64   = filebase64("${path.module}/../../load/scenarios.js")
    diagnostics_js_b64 = filebase64("${path.module}/../../load/diagnostics.js")
    common_js_b64      = filebase64("${path.module}/../../load/lib/common.js")
  })

  service_account {
    email = google_service_account.generator.email
    scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
    ]
  }

  labels = {
    project    = "cwm-bench"
    test_id    = local.id_slug
    managed_by = "terraform"
    role       = "generator"
  }
}
