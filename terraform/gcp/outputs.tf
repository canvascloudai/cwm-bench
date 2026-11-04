output "project_id" {
  description = "Project id from var.project_id. Sensitive so plan output does not treat it as a casual string. Do not commit the applied value."
  value       = var.project_id
  sensitive   = true
}

output "alb_dns" {
  description = "External HTTP(S) load balancer address. k6 TARGET=http://<alb_dns>"
  value       = google_compute_global_address.lb.address
}

output "generator_instance_id" {
  description = "Generator numeric instance id, known after apply."
  value       = google_compute_instance.generator.instance_id
}

output "generator_name" {
  description = "Generator VM name. gcloud compute ssh uses this, not the numeric id."
  value       = google_compute_instance.generator.name
}

output "generator_zone" {
  description = "Generator zone. Always inside var.region."
  value       = var.zone
}

output "app_instance_ids" {
  description = "MIG name, one entry, so the adapter can see a non-empty app address. Live member ids come from Cloud Monitoring at collect, not from this list."
  value       = [google_compute_region_instance_group_manager.app.name]
}

output "resolved_ami_id" {
  description = "Pinned image passed in var.app_image. Copy the caller's value into campaign notes outside git if it contains a project id."
  value       = var.app_image
  sensitive   = true
}

output "ami_source" {
  description = "The image is always the variable. There is no drifting family lookup."
  value       = "variable"
}

output "rds_identifier" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.main.name
}

output "sql_instance_name" {
  description = "Cloud SQL instance name. Monitoring filters on this name, not on a project-qualified database_id."
  value       = google_sql_database_instance.main.name
}

output "rds_endpoint" {
  description = "Cloud SQL private IP."
  value       = google_sql_database_instance.main.private_ip_address
}

output "generator_ip" {
  description = "Generator ephemeral public IPv4."
  value       = google_compute_instance.generator.network_interface[0].access_config[0].nat_ip
}

output "dashboard_url" {
  description = "Cloud Monitoring console link. The project id comes from the variable at apply time."
  value       = "https://console.cloud.google.com/monitoring/dashboards?project=${var.project_id}"
  sensitive   = true
}

output "mysql_max_connections" {
  description = "Declared max_connections database flag."
  value       = var.mysql_max_connections
}

output "mysql_max_prepared_stmt_count" {
  description = "Declared max_prepared_stmt_count. 16382 means the flag was not set."
  value       = var.mysql_max_prepared_stmt_count
}

output "db_parameter_group_name" {
  description = "Cloud SQL instance that holds the database flags. There is no separate parameter group."
  value       = google_sql_database_instance.main.name
}

output "topology_declaration" {
  description = "Topology as applied. cloud=gcp selects the GCP adapter path."
  value = {
    cloud                   = "gcp"
    region                  = var.region
    zone                    = var.zone
    alb                     = "application"
    app_count               = var.app_count
    app_instance_type       = var.app_machine_type
    app_pool_size           = var.app_pool_size
    app_profile             = var.app_profile
    app_workers             = var.app_workers
    db_instance_class       = var.db_tier
    db_engine               = "mysql"
    db_engine_version       = "8.0"
    db_multi_az             = false
    mysql_max_connections   = var.mysql_max_connections
    generator_instance_type = var.generator_machine_type
    test_id                 = var.test_id
  }
}
