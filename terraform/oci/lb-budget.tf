resource "oci_load_balancer_load_balancer" "main" {
  compartment_id = var.compartment_id
  display_name   = var.test_id
  shape          = "flexible"
  is_private     = false
  subnet_ids     = [oci_core_subnet.lb.id]
  freeform_tags  = local.tags
  shape_details {
    minimum_bandwidth_in_mbps = 10
    maximum_bandwidth_in_mbps = 100
  }
}
resource "oci_load_balancer_backend_set" "app" {
  load_balancer_id = oci_load_balancer_load_balancer.main.id
  name             = "app"
  policy           = "ROUND_ROBIN"
  health_checker {
    protocol = "HTTP"
    port     = 8080
    url_path = "/health"
  }
}
resource "oci_load_balancer_backend" "app" {
  count            = 2
  load_balancer_id = oci_load_balancer_load_balancer.main.id
  backendset_name  = oci_load_balancer_backend_set.app.name
  ip_address       = oci_core_instance.app[count.index].private_ip
  port             = 8080
}
resource "oci_load_balancer_listener" "http" {
  load_balancer_id         = oci_load_balancer_load_balancer.main.id
  name                     = "http"
  default_backend_set_name = oci_load_balancer_backend_set.app.name
  port                     = 80
  protocol                 = "HTTP"
}
resource "oci_budget_budget" "main" {
  compartment_id = var.tenancy_id
  amount         = 25
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.compartment_id]
  display_name   = var.test_id
  freeform_tags  = local.tags
}
resource "oci_budget_alert_rule" "actual" {
  for_each       = toset(["15", "25"])
  budget_id      = oci_budget_budget.main.id
  type           = "ACTUAL"
  threshold      = tonumber(each.value)
  threshold_type = "ABSOLUTE"
  recipients     = var.budget_recipients
  display_name   = "actual-${each.value}"
  message        = "Informational only. No shutdown or automated action."
}
