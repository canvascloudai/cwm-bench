output "oci" {
  sensitive = true
  value = {
    cloud                  = "oci"
    region                 = "us-ashburn-1"
    compartment_id         = var.compartment_id
    compartment_name       = data.oci_identity_compartment.target.name
    availability_domain    = var.availability_domain
    test_id                = var.test_id
    measurement_sha        = var.measurement_sha
    generator_id           = oci_core_instance.generator.id
    generator_ip           = oci_core_instance.generator.public_ip
    app_ids                = oci_core_instance.app[*].id
    app_ips                = oci_core_instance.app[*].public_ip
    db_id                  = oci_mysql_mysql_db_system.main.id
    db_configuration_id    = oci_mysql_mysql_configuration.main.id
    lb_id                  = oci_load_balancer_load_balancer.main.id
    target                 = "http://${oci_load_balancer_load_balancer.main.ip_address_details[0].ip_address}"
    vcn_id                 = oci_core_vcn.main.id
    scored_resource_ids    = concat(oci_core_instance.app[*].id, oci_core_instance.app[*].boot_volume_id, [oci_mysql_mysql_db_system.main.id, oci_load_balancer_load_balancer.main.id])
    generator_resource_ids = [oci_core_instance.generator.id, oci_core_instance.generator.boot_volume_id]
    expected = {
      app_count    = 2, shape = "VM.Standard.E4.Flex", ocpus = 2, memory_gb = 16
      profile      = "lean", pool = 250, workers = 1, node_major = 20
      db_shape     = "MySQL.2", db_storage_gb = 100, max_connections = 1000
      heatwave     = false, ha = false, backups = false, delete_protected = false
      final_backup = "SKIP_FINAL_BACKUP", k6 = "v0.54.0", lb_min = 10, lb_max = 100
    }
  }
}
