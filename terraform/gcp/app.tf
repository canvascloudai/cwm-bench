resource "google_compute_instance_template" "app" {
  name_prefix  = "cwm-app-"
  machine_type = var.app_machine_type
  tags         = ["cwm-app"]

  disk {
    source_image = var.app_image
    auto_delete  = true
    boot         = true
    disk_type    = "pd-balanced"
    disk_size_gb = var.app_root_volume_gb
  }

  network_interface {
    subnetwork = google_compute_subnetwork.public.id
    access_config {}
  }

  metadata_startup_script = templatefile("${path.module}/userdata/app.sh.tftpl", {
    mysql_host       = google_sql_database_instance.main.private_ip_address
    mysql_user       = var.db_username
    mysql_database   = "cwmbench"
    app_pool_size    = var.app_pool_size
    app_queue_limit  = var.app_queue_limit
    app_profile      = var.app_profile
    app_workers      = var.app_workers
    secret_id        = google_secret_manager_secret.db_password.secret_id
    project_id       = var.project_id
    git_url          = var.app_source_git_url
    git_ref          = var.app_source_git_ref
    test_id          = var.test_id
    server_js_b64    = filebase64("${path.module}/../../app/src/server.js")
    package_json_b64 = filebase64("${path.module}/../../app/package.json")
    seed_sql_b64     = filebase64("${path.module}/../../app/seed/seed.sql")
  })

  service_account {
    email = google_service_account.app.email
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
    role       = "app"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_region_instance_group_manager" "app" {
  name               = "${local.name}-app-${local.id_slug}"
  region             = var.region
  base_instance_name = "${local.name}-app"
  target_size        = var.app_count

  version {
    instance_template = google_compute_instance_template.app.id
  }

  named_port {
    name = "http"
    port = 8080
  }

  update_policy {
    type                         = "PROACTIVE"
    minimal_action               = "REPLACE"
    max_surge_fixed              = 3
    max_unavailable_fixed        = 0
    instance_redistribution_type = "PROACTIVE"
  }
}
