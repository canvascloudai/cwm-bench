resource "oci_core_vcn" "main" {
  compartment_id = var.compartment_id
  cidr_blocks    = ["10.42.0.0/16"]
  display_name   = var.test_id
  freeform_tags  = local.tags
  lifecycle {
    precondition {
      condition     = data.oci_identity_compartment.target.name == "cwm-bench-oci"
      error_message = "The runtime compartment must be cwm-bench-oci."
    }
    precondition {
      condition     = endswith(var.availability_domain, "AD-${regex("-ad([123])", var.test_id)[0]}")
      error_message = "Apply id and actual availability domain disagree."
    }
  }
}
resource "oci_core_internet_gateway" "main" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  freeform_tags  = local.tags
  enabled        = true
}
resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  freeform_tags  = local.tags
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

# App and generator need outbound HTTPS for pinned bootstrap; only the LB may
# reach app HTTP, and only the controller /32 may reach SSH. MySQL is private.
resource "oci_core_security_list" "nodes" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  freeform_tags  = local.tags
  ingress_security_rules {
    protocol = "6"
    source   = var.controller_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }
  ingress_security_rules {
    protocol = "6"
    source   = "10.42.1.0/24"
    tcp_options {
      min = 8080
      max = 8080
    }
  }
  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }
}
resource "oci_core_security_list" "lb" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  freeform_tags  = local.tags
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }
  egress_security_rules {
    protocol    = "6"
    destination = "10.42.2.0/24"
    tcp_options {
      min = 8080
      max = 8080
    }
  }
}
resource "oci_core_security_list" "db" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.main.id
  freeform_tags  = local.tags
  ingress_security_rules {
    protocol = "6"
    source   = "10.42.2.0/24"
    tcp_options {
      min = 3306
      max = 3306
    }
  }
}
resource "oci_core_subnet" "lb" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.42.1.0/24"
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_security_list.lb.id]
  freeform_tags     = local.tags
}
resource "oci_core_subnet" "nodes" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.42.2.0/24"
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_security_list.nodes.id]
  freeform_tags     = local.tags
}
resource "oci_core_subnet" "db" {
  compartment_id             = var.compartment_id
  vcn_id                     = oci_core_vcn.main.id
  cidr_block                 = "10.42.3.0/24"
  prohibit_public_ip_on_vnic = true
  security_list_ids          = [oci_core_security_list.db.id]
  freeform_tags              = local.tags
}
