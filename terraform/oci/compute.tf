resource "oci_core_instance" "app" {
  count                = 2
  compartment_id       = var.compartment_id
  availability_domain  = var.availability_domain
  shape                = "VM.Standard.E4.Flex"
  display_name         = "${var.test_id}-app-${count.index}"
  freeform_tags        = merge(local.tags, { role = "app" })
  preserve_boot_volume = false
  shape_config {
    ocpus         = 2
    memory_in_gbs = 16
  }
  source_details {
    source_type = "image"
    source_id   = var.image_id
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.nodes.id
    assign_public_ip = true
  }
  agent_config {
    is_monitoring_disabled = false
    plugins_config {
      name          = "Compute Instance Monitoring"
      desired_state = "ENABLED"
    }
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/userdata/app.sh.tftpl", {
      measurement_sha = var.measurement_sha
      mysql_host      = oci_mysql_mysql_db_system.main.ip_address
      db_password     = random_password.db.result
      seed            = count.index == 0
    }))
  }
}
resource "oci_core_instance" "generator" {
  compartment_id       = var.compartment_id
  availability_domain  = var.availability_domain
  shape                = "VM.Standard.E4.Flex"
  display_name         = "${var.test_id}-generator"
  freeform_tags        = merge(local.tags, { role = "generator" })
  preserve_boot_volume = false
  shape_config {
    ocpus         = 2
    memory_in_gbs = 16
  }
  source_details {
    source_type = "image"
    source_id   = var.image_id
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.nodes.id
    assign_public_ip = true
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/userdata/generator.sh.tftpl", {
      measurement_sha = var.measurement_sha
    }))
  }
}
